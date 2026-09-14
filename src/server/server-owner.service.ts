import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Inject, Injectable } from '@nestjs/common';

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
import { PublishedControlService } from '../processes/published-control.service.js';

const CORE_ENTRY = fileURLToPath(new URL('../bin/revo-core-host.js', import.meta.url));
const CLOSE_MILLISECONDS = 5_000;

export interface ServerOwnerConfiguration {
  readonly channel: string;
  readonly dataDir: string;
  readonly databaseUrl?: string;
  readonly host: string;
  readonly port: number;
  readonly publicUrl: string;
  readonly runtimeDir: string;
  readonly startupTimeout: number;
  readonly version: string;
}

export interface OpenServerOwnerRequest {
  readonly configuration: ServerOwnerConfiguration;
  readonly environment: NodeJS.ProcessEnv;
  readonly operationId: string;
  readonly trustedEnvironmentNames?: readonly string[];
  readonly executable?: string;
  readonly coreEntry?: string;
  readonly now?: () => number;
}

export type OpenServerOwnerResult = { readonly kind: 'busy' } | ServerOwnerResource;

export interface ServerOwnerReady {
  readonly kind: 'ready';
  readonly url: string;
}

export type ServerOwnerOutcome =
  | { readonly kind: 'stopped' }
  | {
      readonly kind: 'failed';
      readonly code: ServerOwnerErrorCode;
      readonly cleanup: 'completed' | 'retained';
    };

type ServerOwnerErrorCode =
  | 'revo.server-owner.cancelled'
  | 'revo.server-owner.core'
  | 'revo.server-owner.database'
  | 'revo.server-owner.invalid-state'
  | 'revo.server-owner.readiness'
  | 'revo.server-owner.stop';

export class ServerOwnerError extends Error {
  constructor(
    readonly code: ServerOwnerErrorCode,
    readonly cleanupCode?: 'revo.server-owner.stop',
  ) {
    super('Server owner operation failed.');
    this.name = 'ServerOwnerError';
  }
}

@Injectable()
export class ServerOwnerService {
  constructor(
    @Inject(PublishedControlService)
    private readonly controls = new PublishedControlService(),
    @Inject(CoreHostProcessService)
    private readonly coreHosts = new CoreHostProcessService(),
  ) {}

  async open(request: OpenServerOwnerRequest): Promise<OpenServerOwnerResult> {
    let owner: ServerOwnerResource | undefined;
    let stopRequested = false;
    const held = await this.controls.open({
      dataDir: request.configuration.dataDir,
      runtimeDir: request.configuration.runtimeDir,
      version: request.configuration.version,
      channel: request.configuration.channel,
      ...(request.configuration.databaseUrl !== undefined
        ? { databaseUrl: request.configuration.databaseUrl }
        : {}),
      startupProgress: { operationId: request.operationId, now: request.now ?? Date.now },
      onStop: () => {
        stopRequested = true;
        return owner?.close();
      },
    });
    if (held.kind === 'busy') {
      return held;
    }
    owner = new ServerOwnerResource(request, held, this.coreHosts);
    if (stopRequested) {
      await owner.close();
    }
    return owner;
  }
}

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
      const operation = this.performClose();
      this.closeOperation = operation;
      void operation.catch(() => {
        if (this.closeOperation === operation) {
          this.closeOperation = undefined;
        }
      });
    }
    return this.closeOperation;
  }

  outcome(): Promise<ServerOwnerOutcome> {
    return this.outcomeOperation;
  }

  private async performStart(callerSignal: AbortSignal): Promise<ServerOwnerReady> {
    const deadline = Date.now() + this.request.configuration.startupTimeout;
    const signal = AbortSignal.any([callerSignal, this.controller.signal]);
    const stopUnavailable = () => {
      this.failureCode ??= 'revo.server-owner.cancelled';
      this.beginObservedClose();
    };
    callerSignal.addEventListener('abort', stopUnavailable, { once: true });
    const deadlineTimer = setTimeout(stopUnavailable, remaining(deadline));
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
      return { kind: 'ready', url: this.request.configuration.publicUrl };
    } catch (error) {
      const primary = normalizeOwnerError(error, signal);
      this.failureCode ??= primary.code;
      try {
        await this.close();
      } catch {
        this.resolveFailure(primary.code, 'retained');
        throw new ServerOwnerError(primary.code, 'revo.server-owner.stop');
      }
      this.resolveFailure(primary.code, 'completed');
      throw primary;
    } finally {
      clearTimeout(deadlineTimer);
      callerSignal.removeEventListener('abort', stopUnavailable);
    }
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
      return await this.held.startDatabase({ signal, timeoutMs: remaining(deadline) });
    } catch {
      throw new ServerOwnerError('revo.server-owner.database');
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
      await progress.start(message.stage);
      return;
    }
    if (message.status === 'completed') {
      await progress.complete(message.stage);
      return;
    }
    await progress.fail(message.stage, { code: message.code ?? 'CORE_HOST_STAGE_FAILED' });
  }

  private async probe(host: string, port: number, signal: AbortSignal, deadline: number) {
    rejectUnavailable(signal, deadline);
    const internalHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const address = internalHost.includes(':') ? `[${internalHost}]` : internalHost;
    let response: Response;
    try {
      response = await fetch(`http://${address}:${String(port)}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(remaining(deadline))]),
      });
      const value: unknown = JSON.parse(await readBoundedResponse(response));
      if (!response.ok || !isReadyGraphql(value)) {
        throw new Error('not ready');
      }
    } catch {
      throw new ServerOwnerError('revo.server-owner.readiness');
    }
  }

  private async performClose(): Promise<void> {
    if (this.core) {
      try {
        await this.core.close(Date.now() + CLOSE_MILLISECONDS);
        await this.core.completionState();
      } catch {
        this.resolveFailure(this.failureCode ?? 'revo.server-owner.stop', 'retained');
        throw new ServerOwnerError('revo.server-owner.stop');
      }
    }
    try {
      await this.held.close();
    } catch {
      this.resolveFailure(this.failureCode ?? 'revo.server-owner.stop', 'retained');
      throw new ServerOwnerError('revo.server-owner.stop');
    }
    if (this.failureCode) {
      this.resolveFailure(this.failureCode, 'completed');
    } else {
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
      () => {
        if (!this.controller.signal.aborted) {
          this.failureCode ??= 'revo.server-owner.core';
          this.beginObservedClose();
        }
      },
      () => {
        this.failureCode ??= 'revo.server-owner.core';
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

  private resolveFailure(code: ServerOwnerErrorCode, cleanup: 'completed' | 'retained') {
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

function normalizeOwnerError(error: unknown, signal: AbortSignal): ServerOwnerError {
  if (error instanceof ServerOwnerError) {
    return error;
  }
  return new ServerOwnerError(
    signal.aborted ? 'revo.server-owner.cancelled' : 'revo.server-owner.core',
  );
}

function isReadyGraphql(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.errors !== undefined || !isRecord(value.data)) {
    return false;
  }
  return value.data['__typename'] === 'Query';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function readBoundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('missing response');
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    const readNext = async (): Promise<string> => {
      const chunk = await reader.read();
      if (chunk.done) {
        return Buffer.concat(chunks, length).toString('utf8');
      }
      length += chunk.value.length;
      if (length > 16_384) {
        throw new Error('oversized response');
      }
      chunks.push(chunk.value);
      return readNext();
    };
    return await readNext();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const remaining = (deadline: number) => Math.max(1, deadline - Date.now());
