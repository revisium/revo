import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ManagedProcessService } from '../processes/managed-process.service.js';
import type { OwnedProcess } from '../processes/managed-process.types.js';
import type { StartupProgressFacade } from '../startup-progress/index.js';
import {
  EmbeddedPostgresPreparationService,
  type OwnedEmbeddedPostgresPreparation,
  readEmbeddedPostgresCredential,
} from './embedded-postgres-preparation.service.js';
import {
  EmbeddedPostgresReadiness,
  isPendingEmbeddedPostgresReadiness,
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
const STOP_GRACE_MS = 1000;
const STOP_KILL_WAIT_MS = 5000;
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
  private closeOperation: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private server: OwnedProcess | undefined;
  private serverCompletion: Promise<void> | undefined;
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
    return (this.active = this.performStart(request).finally(() => {
      this.active = undefined;
      this.controller = undefined;
    }));
  }

  close(): Promise<void> {
    this.closing = true;
    this.controller?.abort();
    this.closeOperation ??= this.performClose();
    return this.closeOperation;
  }

  async settled(): Promise<void> {
    await this.active?.catch(() => undefined);
    await this.serverCompletion;
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
      if (this.closing || !this.serverCompletion || this.server !== ready.child || ready.exited()) {
        throw new EmbeddedPostgresError('process');
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
        throw new EmbeddedPostgresError(failure.reason, true);
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
          String(reservation.port),
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
    const diagnostic = captureDiagnostic(child.stderr);
    let exited: import('../processes/managed-process.types.js').ProcessCompletion | undefined;
    const serverCompletion = child.completion.then((completion) => {
      exited = completion;
      if (this.server === child) {
        this.server = undefined;
        this.started = undefined;
      }
      if (this.serverCompletion === serverCompletion) {
        this.serverCompletion = undefined;
      }
    });
    this.serverCompletion = serverCompletion;
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
          () => exited,
        ).then(() => 'ready' as const),
        child.completion.then(() => 'exited' as const),
      ]);
      if (outcome === 'exited') {
        throw new EmbeddedPostgresError('process');
      }
      return { kind: 'ready', port: reservation.port, child, exited: () => exited !== undefined };
    } catch (error) {
      attemptController.abort();
      let failure = error;
      if (signal.aborted) {
        await this.readiness.close().catch(() => {
          failure = new EmbeddedPostgresError('process');
        });
      }
      if (!exited && !isTerminalEmbeddedPostgresReadiness(error)) {
        try {
          exited = await raceCancellation(child.completion, signal, deadline, () => undefined);
        } catch (waitError) {
          failure = waitError;
        }
      }
      if (!exited) {
        await this.stopServer();
      }
      const completion = exited;
      if (!completion) {
        throw safeError(failure, signal);
      }
      if (!signal.aborted && isBindConflict(await diagnostic, completion)) {
        return { kind: 'bind-conflict' };
      }
      throw failure;
    } finally {
      attemptController.abort();
    }
  }

  private async waitUntilReady(
    port: number,
    password: string,
    startupNonce: string,
    signal: AbortSignal,
    deadline: number,
    exited: () => unknown,
  ): Promise<void> {
    rejectCancellation(signal);
    if (Date.now() >= deadline) {
      throw new EmbeddedPostgresError('cancelled');
    }
    if (exited()) {
      throw new EmbeddedPostgresError('process');
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

  private async stopServer() {
    const server = this.server;
    if (!server) {
      return;
    }
    try {
      await this.processes.stop(server, { graceMs: STOP_GRACE_MS, killWaitMs: STOP_KILL_WAIT_MS });
      await server.completion;
    } catch {
      this.stopFailure = true;
      throw new EmbeddedPostgresError('process');
    }
  }

  private async performClose() {
    let failed = false;
    const readinessClose = this.readiness.close().catch(() => {
      failed = true;
    });
    const serverStop = this.stopServer().catch(() => {
      failed = true;
    });
    await Promise.all([readinessClose, serverStop]);
    if (this.active) {
      failed = true;
    }
    await this.preparation.close().catch(() => {
      failed = true;
    });
    if (failed || this.serverCompletion || this.stopFailure) {
      throw new EmbeddedPostgresError('process');
    }
  }
}

interface ReadyAttempt {
  readonly kind: 'ready';
  readonly port: number;
  readonly child: OwnedProcess;
  readonly exited: () => boolean;
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
const safeError = (error: unknown, signal: AbortSignal) =>
  error instanceof EmbeddedPostgresError
    ? error
    : new EmbeddedPostgresError(signal.aborted ? 'cancelled' : 'process');
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
