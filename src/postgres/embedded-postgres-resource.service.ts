import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';

import { Inject, Injectable } from '@nestjs/common';

import { ManagedProcessService } from '../processes/managed-process.service.js';
import type { OwnedProcess, ProcessCompletion } from '../processes/managed-process.types.js';
import type { StartupProgressFacade } from '../startup-progress/index.js';
import {
  EmbeddedPostgresPreparationService,
  type OwnedEmbeddedPostgresPreparation,
  readEmbeddedPostgresCredential,
} from './embedded-postgres-preparation.service.js';
import {
  EmbeddedPostgresReadiness,
  isPendingEmbeddedPostgresReadiness,
  isStartupNonceMismatch,
  isTerminalEmbeddedPostgresReadiness,
} from './embedded-postgres-readiness.js';
import type {
  StartedEmbeddedDatabase,
  StartDatabaseRequest,
} from './embedded-postgres-resource.types.js';
import { EmbeddedPostgresError } from './embedded-postgres.types.js';
import { LoopbackPortAllocator } from './loopback-port-allocator.js';

const HOST = '127.0.0.1' as const;
const DATABASE = 'revo' as const;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const STOP_GRACE_MS = 20_000;
const STOP_KILL_WAIT_MS = 5000;
const POSTGRES_SETTLEMENT_TIMEOUT_MS = 5000;
const POSTGRES_SETTLEMENT_POLL_MS = 25;
const ATTEMPTS = 3;
const LOOPBACK_BIND_CONFLICT = 'could not bind IPv4 address "127.0.0.1": Address already in use';

@Injectable()
export class EmbeddedPostgresResourceService {
  constructor(
    @Inject(EmbeddedPostgresPreparationService)
    private readonly preparation = new EmbeddedPostgresPreparationService(),
    @Inject(ManagedProcessService)
    private readonly processes = new ManagedProcessService(),
    @Inject(LoopbackPortAllocator)
    private readonly ports = new LoopbackPortAllocator(),
  ) {}

  bind(canonicalDataDir: string, progress: StartupProgressFacade) {
    return new OwnedEmbeddedPostgresResource(
      this.preparation.bind(canonicalDataDir, progress),
      this.processes,
      this.ports,
      canonicalDataDir,
      progress,
    );
  }
}

export class OwnedEmbeddedPostgresResource {
  private active: Promise<StartedEmbeddedDatabase> | undefined;
  private readonly readiness = new EmbeddedPostgresReadiness();
  private closing = false;
  private closeOperation: CloseAttempt | undefined;
  private controller: AbortController | undefined;
  private server: OwnedProcess | undefined;
  private serverCompletion: Promise<void> | undefined;
  private settlement: PostgresSettlementAttempt | undefined;
  private started: StartedEmbeddedDatabase | undefined;
  private stopFailure = false;

  constructor(
    private readonly preparation: OwnedEmbeddedPostgresPreparation,
    private readonly processes: ManagedProcessService,
    private readonly ports: LoopbackPortAllocator,
    private readonly canonicalDataDir: string,
    private readonly progress: StartupProgressFacade,
  ) {}

  prepareEmbeddedPostgres(
    request: import('./embedded-postgres.types.js').PrepareEmbeddedPostgresRequest,
  ) {
    if (this.closing || this.stopFailure || this.server || this.serverCompletion) {
      return Promise.reject(new EmbeddedPostgresError(this.closing ? 'cancelled' : 'process'));
    }
    return this.preparation.prepare(request);
  }

  start(request: StartDatabaseRequest): Promise<StartedEmbeddedDatabase> {
    if (this.closing) {
      return Promise.reject(new EmbeddedPostgresError('cancelled'));
    }
    if (this.started) {
      return Promise.resolve(this.started);
    }
    if (this.active) {
      return this.active;
    }
    if (this.server || this.serverCompletion || this.stopFailure) {
      return Promise.reject(new EmbeddedPostgresError('process'));
    }
    const operation = this.performStart(request).finally(() => {
      this.active = undefined;
      this.controller = undefined;
    });
    this.active = operation;
    return operation;
  }

  close(): Promise<void> {
    this.closing = true;
    this.controller?.abort();
    const previous = this.closeOperation;
    if (previous && (previous.state !== 'rejected' || !this.canRetryClose(previous))) {
      return previous.promise;
    }
    if (previous && this.closeOperation === previous) {
      this.closeOperation = undefined;
    }
    const retryMarkerCheck = this.settlement?.checkFailure === 'marker';
    if (retryMarkerCheck && this.settlement) {
      this.settlement.retryCheck = undefined;
    }
    const operation: CloseAttempt = {
      promise: Promise.resolve(),
      settlement: this.settlement,
      startup: this.active,
      state: 'pending',
      mayRetryAfterChildExit: false,
      retryableMarkerFailure: false,
      readinessFailed: false,
      preparationFailed: false,
    };
    operation.promise = this.performClose(retryMarkerCheck, operation).then(
      () => {
        operation.state = 'fulfilled';
      },
      (error: unknown) => {
        operation.state = 'rejected';
        throw error;
      },
    );
    this.closeOperation = operation;
    return operation.promise;
  }

  async settled(): Promise<void> {
    await this.active?.catch(() => undefined);
    await this.serverCompletion;
    const closeOperation = this.closeOperation;
    if (
      closeOperation &&
      closeOperation.settlement === undefined &&
      closeOperation.startup !== undefined &&
      this.settlement?.startup === closeOperation.startup
    ) {
      closeOperation.settlement = this.settlement;
    }
    try {
      await this.requireSettlement(false);
    } catch (error) {
      const operation = this.closeOperation;
      if (
        this.settlement?.checkFailure === 'marker' &&
        !this.server &&
        !this.serverCompletion &&
        !this.active &&
        !this.stopFailure &&
        operation?.state === 'rejected' &&
        operation.settlement === this.settlement &&
        operation.mayRetryAfterChildExit &&
        !operation.readinessFailed &&
        !operation.preparationFailed
      ) {
        operation.retryableMarkerFailure = true;
      }
      throw error;
    }
    await this.readiness.close().catch(() => undefined);
    await this.preparation.settled();
  }

  private async performStart(request: StartDatabaseRequest): Promise<StartedEmbeddedDatabase> {
    validateRequest(request);
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    const deadline = Date.now() + request.timeoutMs;
    const timer = setTimeout(abort, request.timeoutMs);
    try {
      const prepared = await this.preparation.prepare({
        signal: controller.signal,
        timeoutMs: remaining(deadline),
      });
      const password = await readEmbeddedPostgresCredential(this.canonicalDataDir);
      await this.progress.start('postgres-start');
      const ready = await this.startAttempts(
        prepared.postgres,
        prepared.clusterDir,
        password,
        controller.signal,
        deadline,
        ATTEMPTS,
      );
      await this.progress.complete('postgres-start');
      rejectCancellation(controller.signal);
      const observedCompletion = ready.exited();
      if (
        this.closing ||
        !this.serverCompletion ||
        this.server !== ready.child ||
        observedCompletion
      ) {
        throw new EmbeddedPostgresError('process', false, observedCompletion);
      }
      this.started = Object.freeze({
        kind: 'embedded',
        host: HOST,
        port: ready.port,
        database: DATABASE,
      });
      return this.started;
    } catch (error) {
      const failure = safeError(error, controller.signal);
      try {
        await this.progress.fail('postgres-start', {
          code: `POSTGRES_${failure.reason.toUpperCase()}`,
        });
      } catch {
        throw new EmbeddedPostgresError(failure.reason, true, failure.observedCompletion);
      }
      throw failure;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
    }
  }

  private async startAttempts(
    executable: string,
    clusterDir: string,
    password: string,
    signal: AbortSignal,
    deadline: number,
    remainingAttempts: number,
  ): Promise<ReadyAttempt> {
    const outcome = await this.startAttempt(executable, clusterDir, password, signal, deadline);
    if (outcome.kind === 'ready') {
      return outcome;
    }
    if (remainingAttempts === 1) {
      throw new EmbeddedPostgresError('process');
    }
    return this.startAttempts(
      executable,
      clusterDir,
      password,
      signal,
      deadline,
      remainingAttempts - 1,
    );
  }

  private async startAttempt(
    executable: string,
    clusterDir: string,
    password: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<{ kind: 'bind-conflict' } | ReadyAttempt> {
    rejectCancellation(signal);
    const reservation = await this.ports.reserve();
    try {
      rejectCancellation(signal);
    } finally {
      await reservation.release();
    }
    rejectCancellation(signal);
    const startupNonce = `revo-${randomBytes(16).toString('hex')}`;
    const attempt = await this.spawnAttempt(
      executable,
      clusterDir,
      reservation.port,
      startupNonce,
      signal,
    );
    const attemptController = new AbortController();
    const attemptSignal = AbortSignal.any([signal, attemptController.signal]);
    try {
      const outcome = await Promise.race([
        this.waitUntilReady(
          reservation.port,
          password,
          startupNonce,
          attemptSignal,
          deadline,
          () => attempt.exited,
        ).then(() => 'ready' as const),
        attempt.child.completion.then((completion) => ({ kind: 'exited' as const, completion })),
      ]);
      if (outcome !== 'ready') {
        throw new EmbeddedPostgresError('process', false, outcome.completion);
      }
      return {
        kind: 'ready',
        port: reservation.port,
        child: attempt.child,
        exited: () => attempt.exited,
      };
    } catch (error) {
      attemptController.abort();
      return this.resolveFailedAttempt(attempt, error, signal, deadline);
    } finally {
      attemptController.abort();
    }
  }

  private async spawnAttempt(
    executable: string,
    clusterDir: string,
    port: number,
    startupNonce: string,
    signal: AbortSignal,
  ): Promise<TrackedAttempt> {
    const spawnController = new AbortController();
    const abortSpawn = () => spawnController.abort();
    signal.addEventListener('abort', abortSpawn, { once: true });
    let child: OwnedProcess;
    try {
      child = await this.processes.start({
        executable,
        args: [
          '-D',
          clusterDir,
          '-h',
          HOST,
          '-p',
          String(port),
          '-c',
          'unix_socket_directories=',
          '-c',
          `cluster_name=${startupNonce}`,
        ],
        cwd: this.canonicalDataDir,
        env: { LC_ALL: 'C' },
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
        cancellation: {
          signal: spawnController.signal,
          graceMs: STOP_GRACE_MS,
          killWaitMs: STOP_KILL_WAIT_MS,
        },
      });
    } finally {
      signal.removeEventListener('abort', abortSpawn);
    }
    this.server = child;
    const attempt: TrackedAttempt = {
      child,
      diagnostic: captureDiagnostic(child.stderr),
      exited: undefined,
    };
    const completion: Promise<PostgresCompletion> = child.completion.then(
      (result) => ({ kind: 'exited', completion: result }),
      () => ({ kind: 'failed', error: new EmbeddedPostgresError('process') }),
    );
    const serverCompletion = completion.then((result) => {
      if (result.kind === 'exited') {
        attempt.exited = result.completion;
      }
      if (this.server === child) {
        this.server = undefined;
        this.started = undefined;
        if (result.kind === 'exited') {
          this.stopFailure = false;
        }
      }
      if (this.serverCompletion === serverCompletion) {
        this.serverCompletion = undefined;
      }
    });
    this.serverCompletion = serverCompletion;
    const settlement: PostgresSettlementAttempt = {
      child,
      clusterDir,
      completion,
      check: Promise.resolve({ kind: 'settled' }),
      retryCheck: undefined,
      checkState: 'pending',
      checkFailure: undefined,
      checkError: undefined,
      startup: this.active,
    };
    settlement.check = this.checkSettlement(settlement);
    this.settlement = settlement;
    return attempt;
  }

  private async resolveFailedAttempt(
    attempt: TrackedAttempt,
    error: unknown,
    signal: AbortSignal,
    deadline: number,
  ): Promise<{ kind: 'bind-conflict' }> {
    let failure = error;
    const retryableBindFailure = this.canBecomeBindConflict(error);
    if (signal.aborted) {
      await this.readiness.close().catch(() => {
        failure = new EmbeddedPostgresError('process');
      });
    }
    if (!attempt.exited && retryableBindFailure) {
      try {
        attempt.exited = await raceCancellation(attempt.child.completion, signal, deadline, () =>
          this.stopServer(),
        );
      } catch (waitError) {
        failure = waitError;
      }
    }
    if (!attempt.exited) {
      await this.stopServer();
    }
    if (!attempt.exited) {
      throw safeError(failure, signal);
    }
    if (
      retryableBindFailure &&
      !signal.aborted &&
      isBindConflict(await attempt.diagnostic, attempt.exited)
    ) {
      await this.requireSettlement(false);
      return { kind: 'bind-conflict' };
    }
    throw failure;
  }

  private canBecomeBindConflict(error: unknown) {
    return isStartupNonceMismatch(error) || !isTerminalEmbeddedPostgresReadiness(error);
  }

  private async waitUntilReady(
    port: number,
    password: string,
    startupNonce: string,
    signal: AbortSignal,
    deadline: number,
    exited: () => ProcessCompletion | undefined,
  ): Promise<void> {
    rejectCancellation(signal);
    if (Date.now() >= deadline) {
      throw new EmbeddedPostgresError('cancelled');
    }
    const observedCompletion = exited();
    if (observedCompletion) {
      throw new EmbeddedPostgresError('process', false, observedCompletion);
    }
    try {
      await this.readiness.initialize({
        port,
        password,
        startupNonce,
        signal,
        timeoutMs: remaining(deadline),
      });
    } catch (error) {
      if (!retryableReadiness(error)) {
        throw safeError(error, signal);
      }
      await waitForRetry(signal, deadline);
      return this.waitUntilReady(port, password, startupNonce, signal, deadline, exited);
    }
  }

  private canRetryClose(operation: CloseAttempt): boolean {
    const settlement = this.settlement;
    return (
      operation.retryableMarkerFailure &&
      operation.settlement === settlement &&
      settlement?.checkFailure === 'marker' &&
      !this.server &&
      !this.serverCompletion &&
      !this.active &&
      !this.stopFailure
    );
  }

  private checkSettlement(settlement: PostgresSettlementAttempt): Promise<SettlementResult> {
    return settlement.completion.then(async (completion) => {
      if (completion.kind === 'failed') {
        settlement.checkState = 'failed';
        settlement.checkFailure = 'completion';
        settlement.checkError = completion.error;
        return { kind: 'failed', stage: 'completion', error: completion.error };
      }
      try {
        await waitForPostgresSettlement(settlement.clusterDir);
        settlement.checkState = 'settled';
        settlement.checkFailure = undefined;
        settlement.checkError = undefined;
        return { kind: 'settled' };
      } catch {
        const error = new EmbeddedPostgresError('process');
        settlement.checkState = 'failed';
        settlement.checkFailure = 'marker';
        settlement.checkError = error;
        return { kind: 'failed', stage: 'marker', error };
      }
    });
  }

  private async requireSettlement(retryFailedMarkerCheck: boolean): Promise<void> {
    const settlement = this.settlement;
    if (!settlement) {
      return;
    }
    let result = await settlement.check;
    if (
      result.kind === 'failed' &&
      retryFailedMarkerCheck &&
      settlement.checkState === 'failed' &&
      (await settlement.completion).kind === 'exited'
    ) {
      settlement.retryCheck ??= this.checkSettlement(settlement);
      settlement.check = settlement.retryCheck;
      result = await settlement.retryCheck;
    }
    if (result.kind === 'failed') {
      throw result.error;
    }
  }

  private async stopServer(retryFailedMarkerCheck = false) {
    const server = this.server;
    if (server) {
      try {
        await this.processes.stop(server, {
          graceMs: STOP_GRACE_MS,
          killWaitMs: STOP_KILL_WAIT_MS,
          escalationSignal: 'SIGINT',
        });
      } catch {
        this.stopFailure = true;
        throw new EmbeddedPostgresError('process');
      }
      try {
        await server.completion;
      } catch {
        this.stopFailure = true;
        throw new EmbeddedPostgresError('process');
      }
    }
    await this.requireSettlement(retryFailedMarkerCheck);
  }

  private async performClose(retryFailedMarkerCheck: boolean, operation: CloseAttempt) {
    let readinessFailed = false;
    let preparationFailed = false;
    let serverStopFailed = false;
    const readinessClose = this.readiness.close().catch(() => {
      readinessFailed = true;
    });
    const serverStop = this.stopServer(retryFailedMarkerCheck).catch(() => {
      serverStopFailed = true;
    });
    await Promise.all([readinessClose, serverStop]);
    await this.preparation.close().catch(() => {
      preparationFailed = true;
    });
    operation.readinessFailed = readinessFailed;
    operation.preparationFailed = preparationFailed;
    operation.mayRetryAfterChildExit =
      !readinessFailed && !preparationFailed && this.settlement?.checkFailure !== 'completion';
    operation.retryableMarkerFailure =
      operation.mayRetryAfterChildExit &&
      !this.server &&
      !this.serverCompletion &&
      !this.stopFailure &&
      this.settlement?.checkFailure === 'marker';
    if (
      readinessFailed ||
      preparationFailed ||
      serverStopFailed ||
      this.active ||
      this.serverCompletion ||
      this.stopFailure ||
      operation.retryableMarkerFailure
    ) {
      throw new EmbeddedPostgresError('process');
    }
  }
}

interface ReadyAttempt {
  readonly kind: 'ready';
  readonly port: number;
  readonly child: OwnedProcess;
  readonly exited: () => ProcessCompletion | undefined;
}

interface TrackedAttempt {
  readonly child: OwnedProcess;
  readonly diagnostic: Promise<string>;
  exited: ProcessCompletion | undefined;
}

type PostgresCompletion =
  | { readonly kind: 'exited'; readonly completion: ProcessCompletion }
  | { readonly kind: 'failed'; readonly error: EmbeddedPostgresError };

type SettlementResult =
  | { readonly kind: 'settled' }
  | {
      readonly kind: 'failed';
      readonly stage: 'completion' | 'marker';
      readonly error: EmbeddedPostgresError;
    };

interface PostgresSettlementAttempt {
  readonly child: OwnedProcess;
  readonly clusterDir: string;
  readonly completion: Promise<PostgresCompletion>;
  readonly startup: Promise<StartedEmbeddedDatabase> | undefined;
  check: Promise<SettlementResult>;
  retryCheck: Promise<SettlementResult> | undefined;
  checkState: 'pending' | 'settled' | 'failed';
  checkFailure: 'completion' | 'marker' | undefined;
  checkError: EmbeddedPostgresError | undefined;
}

interface CloseAttempt {
  promise: Promise<void>;
  settlement: PostgresSettlementAttempt | undefined;
  readonly startup: Promise<StartedEmbeddedDatabase> | undefined;
  state: 'pending' | 'fulfilled' | 'rejected';
  mayRetryAfterChildExit: boolean;
  retryableMarkerFailure: boolean;
  readinessFailed: boolean;
  preparationFailed: boolean;
}

const validateRequest = (request: StartDatabaseRequest) => {
  if (
    request.signal.aborted ||
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > 2_147_483_647
  ) {
    throw new EmbeddedPostgresError(request.signal.aborted ? 'cancelled' : 'invalid');
  }
};
const remaining = (deadline: number) => Math.max(1, deadline - Date.now());
const rejectCancellation = (signal: AbortSignal) => {
  if (signal.aborted) {
    throw new EmbeddedPostgresError('cancelled');
  }
};
const safeError = (error: unknown, signal: AbortSignal) => {
  if (error instanceof EmbeddedPostgresError) {
    return error;
  }
  const reason = signal.aborted ? 'cancelled' : 'process';
  return new EmbeddedPostgresError(reason);
};
const retryableReadiness = (error: unknown) => isPendingEmbeddedPostgresReadiness(error);
const isBindConflict = (
  diagnostic: string,
  completion: { exitCode: number | null; signal: NodeJS.Signals | null },
) =>
  completion.exitCode !== null &&
  completion.exitCode !== 0 &&
  completion.signal === null &&
  diagnostic.includes(LOOPBACK_BIND_CONFLICT);

const captureDiagnostic = (stderr: NodeJS.ReadableStream | undefined) => {
  if (!stderr) {
    return Promise.resolve('');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  return new Promise<string>((resolve) => {
    const capture = (chunk: Buffer | string) => {
      const available = MAX_DIAGNOSTIC_BYTES - bytes;
      if (available <= 0) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const bounded = buffer.subarray(0, available);
      chunks.push(bounded);
      bytes += bounded.length;
    };
    const finish = () => {
      stderr.removeListener('data', capture);
      stderr.removeListener('end', finish);
      stderr.removeListener('close', finish);
      stderr.removeListener('error', finish);
      resolve(Buffer.concat(chunks, bytes).toString('utf8'));
    };
    stderr.on('data', capture);
    stderr.once('end', finish);
    stderr.once('close', finish);
    stderr.once('error', finish);
  });
};

async function waitForPostgresSettlement(clusterDir: string): Promise<void> {
  const pidPath = `${clusterDir}/postmaster.pid`;
  const deadline = performance.now() + POSTGRES_SETTLEMENT_TIMEOUT_MS;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- settlement must observe each filesystem state in order.
    const observation = await observePostgresMarker(pidPath, deadline);
    if (observation === 'absent') {
      return;
    }
    const settlementRemainingMs = deadline - performance.now();
    if (settlementRemainingMs <= 0) {
      throw new EmbeddedPostgresError('process');
    }
    // oxlint-disable-next-line no-await-in-loop -- bounded polling waits for the owned PostgreSQL shutdown marker.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(POSTGRES_SETTLEMENT_POLL_MS, settlementRemainingMs)),
    );
  }
}

async function observePostgresMarker(
  pidPath: string,
  deadline: number,
): Promise<'present' | 'absent'> {
  try {
    const metadata = await lstatBeforeDeadline(pidPath, deadline);
    if (performance.now() > deadline || metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new EmbeddedPostgresError('process');
    }
    return 'present';
  } catch (error) {
    if (error instanceof EmbeddedPostgresError) {
      throw error;
    }
    if (isMissingPathError(error) && performance.now() <= deadline) {
      return 'absent';
    }
    throw new EmbeddedPostgresError('process');
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function lstatBeforeDeadline(pidPath: string, deadline: number) {
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) {
    throw new EmbeddedPostgresError('process');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lstat(pidPath),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new EmbeddedPostgresError('process')), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

const waitForRetry = (signal: AbortSignal, deadline: number) =>
  raceCancellation(
    new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining(deadline)))),
    signal,
    deadline,
    () => undefined,
  );

async function raceCancellation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadline: number,
  cancel: () => void | Promise<void>,
) {
  rejectCancellation(signal);
  if (Date.now() >= deadline) {
    throw new EmbeddedPostgresError('cancelled');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    listener = () => {
      void Promise.resolve(cancel()).catch(() => undefined);
      reject(new EmbeddedPostgresError('cancelled'));
    };
    signal.addEventListener('abort', listener, { once: true });
    timer = setTimeout(listener, remaining(deadline));
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (listener) {
      signal.removeEventListener('abort', listener);
    }
  }
}
