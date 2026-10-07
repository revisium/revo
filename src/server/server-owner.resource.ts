import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCoreChildEnvironment } from '../core-host/core-child-environment.js';
import { CORE_HOST_PROTOCOL, type CoreHostStageMessage } from '../core-host/core-child-protocol.js';
import { buildCoreDatabaseHandoff } from '../core-host/core-database-handoff.js';
import {
  CoreHostProcessResource,
  CoreHostProcessService,
} from '../core-host/core-host-process.service.js';
import { readEmbeddedPostgresCredential } from '../postgres/embedded-postgres-preparation.service.js';
import type { StartedDatabase } from '../postgres/index.js';
import type { PublishedControl } from '../processes/control-discovery.types.js';
import type { ControlServerStatus } from '../processes/control-endpoint.types.js';
import { PublishedControlError } from '../processes/published-control.service.js';
import { RevoConsoleLogger } from '../server-logs/revo-console-logger.js';
import type {
  ServerLifecycleCode,
  ServerLifecycleCorePhase,
} from '../server-logs/server-lifecycle.types.js';
import { CORE_CLOSE_MILLISECONDS } from '../stop-timing.js';
import { remainingMilliseconds } from '../timers.js';
import {
  isDatabaseFailure,
  normalizeOwnerError,
  safeDatabaseFailure,
  ServerOwnerError,
  startFailureReason,
  type ServerOwnerErrorCode,
} from './server-owner-error.js';
import { requestCoreReadiness } from './server-owner-readiness.js';
import type {
  OpenServerOwnerRequest,
  ServerOwnerOutcome,
  ServerOwnerReady,
} from './server-owner.types.js';

const CORE_ENTRY = fileURLToPath(new URL('../bin/revo-core-host.js', import.meta.url));
const logger = new RevoConsoleLogger('ServerOwner');

export class ServerOwnerResource {
  readonly kind = 'held' as const;
  private readonly controller = new AbortController();
  private core: CoreHostProcessResource | undefined;
  private startOperation: Promise<ServerOwnerReady> | undefined;
  private closeOperation: Promise<void> | undefined;
  private completionObserved = false;
  private ready = false;
  private failureCode: ServerOwnerErrorCode | undefined;
  private readonly outcomeOperation: Promise<ServerOwnerOutcome>;
  private resolveOutcome: ((outcome: ServerOwnerOutcome) => void) | undefined;
  private retryableCloseFailure = false;
  private effectiveListener: { readonly host: string; readonly port: number } | undefined;
  private lifecyclePhase: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' = 'starting';
  private failureOwnership: 'retained' | 'unconfirmed' = 'unconfirmed';

  constructor(
    private readonly request: OpenServerOwnerRequest,
    private readonly held: Extract<PublishedControl, { readonly kind: 'held' }>,
    private readonly coreHosts: CoreHostProcessService,
  ) {
    this.outcomeOperation = new Promise((resolve) => {
      this.resolveOutcome = resolve;
    });
  }

  start(signal: AbortSignal): Promise<ServerOwnerReady> {
    if (this.startOperation || this.closeOperation || this.ready) {
      return Promise.reject(new ServerOwnerError('revo.server-owner.invalid-state'));
    }
    const operation = this.performStart(signal);
    this.startOperation = operation;
    return operation;
  }

  close(): Promise<void> {
    this.controller.abort();
    if (!this.closeOperation) {
      if (this.lifecyclePhase !== 'stopped') {
        this.lifecyclePhase = 'stopping';
      }
      const operation = this.performClose();
      this.closeOperation = operation;
      void operation.catch(() => {
        if (this.closeOperation === operation && this.retryableCloseFailure) {
          this.closeOperation = undefined;
        }
      });
    }
    return this.closeOperation;
  }

  async stopFromControl() {
    try {
      await this.close();
      return { kind: 'completed' as const };
    } catch {
      return {
        kind: 'failed' as const,
        ownership: this.retryableCloseFailure ? ('retained' as const) : ('unconfirmed' as const),
      };
    }
  }

  outcome(): Promise<ServerOwnerOutcome> {
    return this.outcomeOperation;
  }

  ownershipReleased(): Promise<void> {
    return this.held.ownershipReleased();
  }

  status(): ControlServerStatus {
    if (this.lifecyclePhase === 'running' && this.effectiveListener) {
      return {
        phase: 'running',
        operationId: this.request.operationId,
        host: this.effectiveListener.host,
        port: this.effectiveListener.port,
        publicUrl: this.request.configuration.publicUrl,
      };
    }
    if (this.lifecyclePhase === 'failed') {
      return {
        phase: 'failed',
        code: this.failureCode ?? 'revo.server-owner.stop',
        operationId: this.request.operationId,
        ownership: this.failureOwnership,
      };
    }
    return { phase: this.lifecyclePhase, operationId: this.request.operationId };
  }

  private async performStart(callerSignal: AbortSignal): Promise<ServerOwnerReady> {
    const deadline = Date.now() + this.request.configuration.startupTimeout;
    const signal = AbortSignal.any([callerSignal, this.controller.signal]);
    const stopUnavailable = () => {
      this.failureCode ??= 'revo.server-owner.cancelled';
      this.emitLifecycle('SERVER_CANCELLED');
      this.beginObservedClose();
    };
    callerSignal.addEventListener('abort', stopUnavailable, { once: true });
    const deadlineTimer = setTimeout(stopUnavailable, remainingMilliseconds(deadline));
    try {
      rejectUnavailable(signal, deadline);
      const { agentWorkspaceDirectory, temporaryWorkingDirectoryRoot } = await this.preparePaths();
      rejectUnavailable(signal, deadline);
      const database = await this.startDatabase(signal, deadline);
      const databaseUrl = await this.databaseUrl(database);
      rejectUnavailable(signal, deadline);
      const childEnvironment = buildCoreChildEnvironment(
        this.request.environment,
        this.request.trustedEnvironmentNames,
      );
      this.core = this.coreHosts.open({
        executable: this.request.executable ?? process.execPath,
        entry: this.request.coreEntry ?? CORE_ENTRY,
        cwd: this.held.canonicalDataDir,
        env: childEnvironment.env,
      });
      const listening = await this.core.start(
        {
          protocol: CORE_HOST_PROTOCOL,
          type: 'start',
          databaseUrl,
          temporaryWorkingDirectoryRoot,
          agentWorkspaceDirectory,
          host: this.request.configuration.host,
          port: this.request.configuration.port,
        },
        {
          signal,
          deadline,
          onStage: (message) => this.persistStage(message),
        },
      );
      this.effectiveListener = { host: listening.host, port: listening.port };
      this.observeCoreCompletion();
      await this.probe(listening.host, listening.port, signal, deadline);
      this.core.assertRunning();
      rejectUnavailable(signal, deadline);
      await requiredProgress(this.held).ready(
        { url: this.request.configuration.publicUrl },
        { signal, deadline, assertRunning: () => requiredCore(this.core).assertRunning() },
      );
      this.core.assertRunning();
      rejectUnavailable(signal, deadline);
      this.ready = true;
      this.lifecyclePhase = 'running';
      this.emitLifecycle('SERVER_READY');
      logger.log(`Server is ready at ${this.request.configuration.publicUrl}.`);
      return { kind: 'ready', url: this.request.configuration.publicUrl };
    } catch (error) {
      return await this.failStart(error, signal);
    } finally {
      clearTimeout(deadlineTimer);
      callerSignal.removeEventListener('abort', stopUnavailable);
    }
  }

  private async failStart(error: unknown, signal: AbortSignal): Promise<never> {
    const primary = normalizeOwnerError(error, signal);
    logger.error(`Server start failed: ${startFailureReason(primary, error)}.`);
    this.failureCode ??= primary.code;
    this.emitStartFailure(primary.code);
    try {
      await this.close();
    } catch {
      this.resolveFailure(primary.code, 'retained');
      throw new ServerOwnerError(primary.code, 'revo.server-owner.stop', primary.databaseFailure);
    }
    this.resolveFailure(primary.code, 'completed');
    throw primary;
  }

  private async preparePaths() {
    const root = join(this.held.canonicalDataDir, 'core');
    const agentWorkspaceDirectory = join(root, 'sessions');
    const temporaryWorkingDirectoryRoot = join(root, 'work');
    await Promise.all([
      mkdir(agentWorkspaceDirectory, { recursive: true, mode: 0o700 }),
      mkdir(temporaryWorkingDirectoryRoot, { recursive: true, mode: 0o700 }),
    ]);
    return { agentWorkspaceDirectory, temporaryWorkingDirectoryRoot };
  }

  private async startDatabase(signal: AbortSignal, deadline: number): Promise<StartedDatabase> {
    if (!this.held.startDatabase) {
      throw new ServerOwnerError('revo.server-owner.database');
    }
    try {
      this.emitLifecycle('DATABASE_STARTING');
      const database = await this.held.startDatabase({
        signal,
        timeoutMs: remainingMilliseconds(deadline),
      });
      this.emitLifecycle('DATABASE_READY');
      return database;
    } catch (error) {
      this.emitLifecycle('DATABASE_FAILED');
      if (!isDatabaseFailure(error)) {
        throw error;
      }
      throw new ServerOwnerError(
        'revo.server-owner.database',
        undefined,
        safeDatabaseFailure(error),
      );
    }
  }

  private async databaseUrl(database: StartedDatabase): Promise<string> {
    if (database.kind === 'external') {
      const configured = this.request.configuration.databaseUrl;
      if (!configured) {
        throw new ServerOwnerError('revo.server-owner.database');
      }
      return buildCoreDatabaseHandoff(configured).databaseUrl;
    }
    const password = await readEmbeddedPostgresCredential(this.held.canonicalDataDir);
    const connection =
      `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${String(database.port)}` +
      '/revo?sslmode=disable';
    return buildCoreDatabaseHandoff(connection).databaseUrl;
  }

  private async persistStage(message: CoreHostStageMessage): Promise<void> {
    const progress = requiredProgress(this.held);
    if (message.status === 'started') {
      this.emitLifecycle('CORE_STAGE_STARTED', message.stage);
      await progress.start(message.stage);
      return;
    }
    if (message.status === 'completed') {
      this.emitLifecycle('CORE_STAGE_COMPLETED', message.stage);
      await progress.complete(message.stage);
      return;
    }
    this.emitLifecycle('CORE_STAGE_FAILED', message.stage);
    await progress.fail(message.stage, { code: message.code ?? 'CORE_HOST_STAGE_FAILED' });
  }

  private async probe(host: string, port: number, signal: AbortSignal, deadline: number) {
    rejectUnavailable(signal, deadline);
    const internalHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const address = internalHost.includes(':') ? `[${internalHost}]` : internalHost;
    try {
      await requestCoreReadiness(
        address,
        port,
        AbortSignal.any([signal, AbortSignal.timeout(remainingMilliseconds(deadline))]),
      );
    } catch (error) {
      logger.failure(`Revo Core readiness check at ${address}:${String(port)} failed`, error);
      throw new ServerOwnerError('revo.server-owner.readiness');
    }
  }

  private async performClose(): Promise<void> {
    if (this.core) {
      try {
        await this.core.close(Date.now() + CORE_CLOSE_MILLISECONDS);
        await this.core.completionState();
      } catch (error) {
        logger.failure('Revo Core did not stop', error);
        this.retryableCloseFailure = true;
        this.emitLifecycle('SERVER_STOP_FAILED');
        this.lifecyclePhase = 'failed';
        this.failureOwnership = 'retained';
        this.resolveFailure(this.failureCode ?? 'revo.server-owner.stop', 'retained');
        throw new ServerOwnerError('revo.server-owner.stop');
      }
    }
    try {
      await this.held.close();
    } catch (error) {
      logger.failure('Server resources did not close', error);
      const ownership = error instanceof PublishedControlError ? error.ownership : 'unconfirmed';
      this.retryableCloseFailure = ownership === 'retained';
      this.lifecyclePhase = 'failed';
      this.failureOwnership = ownership === 'retained' ? 'retained' : 'unconfirmed';
      this.resolveFailure(
        this.failureCode ?? 'revo.server-owner.stop',
        ownership === 'released' ? 'completed' : ownership,
      );
      throw new ServerOwnerError('revo.server-owner.stop');
    }
    if (this.failureCode) {
      this.lifecyclePhase = 'failed';
      this.failureOwnership = 'unconfirmed';
      this.resolveFailure(this.failureCode, 'completed');
    } else {
      this.lifecyclePhase = 'stopped';
      this.resolveOutcome?.({ kind: 'stopped' });
      this.resolveOutcome = undefined;
    }
  }

  private observeCoreCompletion() {
    if (this.completionObserved || !this.core) {
      return;
    }
    this.completionObserved = true;
    const core = this.core;
    void core.settled().then(
      (completion) => {
        if (!this.controller.signal.aborted) {
          logger.error(
            `Revo Core exited unexpectedly (exit code ${String(completion.exitCode)}, signal ${String(completion.signal)}).`,
          );
          this.failureCode ??= 'revo.server-owner.core';
          this.emitLifecycle('SERVER_CORE_FAILED');
          this.beginObservedClose();
        }
      },
      (error: unknown) => {
        logger.failure('Revo Core completion could not be observed', error);
        this.failureCode ??= 'revo.server-owner.core';
        this.emitLifecycle('SERVER_CORE_FAILED');
        this.beginObservedClose();
      },
    );
  }

  private beginObservedClose() {
    void this.close().then(
      () => undefined,
      () => undefined,
    );
  }

  private emitLifecycle(code: ServerLifecycleCode, corePhase?: ServerLifecycleCorePhase): void {
    void this.held.lifecycle?.emit(code, corePhase).catch(() => undefined);
  }

  private emitStartFailure(code: ServerOwnerErrorCode): void {
    if (code === 'revo.server-owner.cancelled') {
      return;
    }
    if (code === 'revo.server-owner.core') {
      this.emitLifecycle('SERVER_CORE_FAILED');
      return;
    }
    if (code === 'revo.server-owner.readiness') {
      this.emitLifecycle('SERVER_READINESS_FAILED');
      return;
    }
    if (code !== 'revo.server-owner.database') {
      this.emitLifecycle('SERVER_START_FAILED');
    }
  }

  private resolveFailure(
    code: ServerOwnerErrorCode,
    cleanup: 'completed' | 'retained' | 'unconfirmed',
  ) {
    this.resolveOutcome?.({ kind: 'failed', code, cleanup });
    this.resolveOutcome = undefined;
  }
}

function requiredProgress(held: Extract<PublishedControl, { readonly kind: 'held' }>) {
  if (!held.progress) {
    throw new ServerOwnerError('revo.server-owner.invalid-state');
  }
  return held.progress;
}

function requiredCore(core: CoreHostProcessResource | undefined): CoreHostProcessResource {
  if (!core) {
    throw new ServerOwnerError('revo.server-owner.invalid-state');
  }
  return core;
}

function rejectUnavailable(signal: AbortSignal, deadline: number) {
  if (signal.aborted || Date.now() >= deadline) {
    throw new ServerOwnerError('revo.server-owner.cancelled');
  }
}
