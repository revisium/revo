import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { errorCode } from '../errors.js';
import { EmbeddedPostgresResourceService } from '../postgres/embedded-postgres-resource.service.js';
import { ExternalPostgresResourceService } from '../postgres/external-postgres-resource.service.js';
import type { ServerLifecycleSink } from '../server-logs/server-lifecycle.types.js';
import { openServerLifecycleStore, serverLifecyclePath } from '../server-logs/store.service.js';
import { OwnedStartupProgress } from '../startup-progress/startup-progress-facade.js';
import { StartupProgressJournalWriter } from '../startup-progress/startup-progress-journal.service.js';
import {
  CONTROL_FILE,
  ControlDiscoveryService,
  MAX_CONTROL_METADATA_BYTES,
} from './control-discovery.service.js';
import type { OpenPublishedControlRequest, PublishedControl } from './control-discovery.types.js';
import { ControlEndpointService } from './control-endpoint.service.js';
import { ProcessIdentityService } from './process-identity.service.js';
import { ServerOwnershipService } from './server-ownership.service.js';

type PublishedControlCleanupFailure = 'endpoint' | 'metadata' | 'ownership';

export class PublishedControlError extends Error {
  readonly code = 'PUBLISHED_CONTROL_ERROR';
  constructor(
    readonly phase: 'startup' | 'close',
    readonly cleanupFailures: readonly PublishedControlCleanupFailure[] = [],
    readonly ownership: 'retained' | 'released' | 'unconfirmed' = 'unconfirmed',
  ) {
    super('Published control lifecycle failed');
    this.name = 'PublishedControlError';
  }
}

@Injectable()
export class PublishedControlService {
  constructor(
    @Inject(ServerOwnershipService) private readonly ownership = new ServerOwnershipService(),
    @Inject(ProcessIdentityService) private readonly identity = new ProcessIdentityService(),
    @Inject(ControlEndpointService) private readonly endpoints = new ControlEndpointService(),
    @Inject(ControlDiscoveryService) private readonly discovery = new ControlDiscoveryService(),
    @Inject(StartupProgressJournalWriter)
    private readonly progressJournal = new StartupProgressJournalWriter(),
    @Inject(EmbeddedPostgresResourceService)
    private readonly postgres = new EmbeddedPostgresResourceService(),
    @Inject(ExternalPostgresResourceService)
    private readonly externalPostgres = new ExternalPostgresResourceService(),
  ) {}

  async open(request: OpenPublishedControlRequest): Promise<PublishedControl> {
    const lease = await this.ownership.acquire(request.dataDir);
    if (lease.kind === 'busy') {
      return lease;
    }
    const canonicalDataDir = dirname(lease.lockPath);
    const lifecycle = await openLifecycle(request, canonicalDataDir);
    emitLifecycle(lifecycle, 'SERVER_STARTING');
    const instanceId = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('hex');
    let endpoint: ListeningEndpoint | undefined;
    let temporaryPath: string | undefined;
    try {
      const process = await this.identity.capture(globalThis.process.pid);
      const createdEndpoint = await this.endpoints.listen({
        runtimeDir: request.runtimeDir,
        instanceId,
        token,
        ...(request.limits ? { limits: request.limits } : {}),
        onStop: request.onStop,
        ...(request.onStatus ? { onStatus: request.onStatus } : {}),
        identity: { version: request.version, channel: request.channel, canonicalDataDir, process },
      });
      endpoint = createdEndpoint;
      const progress = request.startupProgress
        ? new OwnedStartupProgress(this.progressJournal, canonicalDataDir, request.startupProgress)
        : undefined;
      const postgres = progress
        ? this.bindPostgres(request, canonicalDataDir, progress)
        : undefined;
      await progress?.initialize();
      const record = {
        schemaVersion: 1 as const,
        instanceId,
        token,
        version: request.version,
        channel: request.channel,
        canonicalDataDir,
        endpoint: createdEndpoint.endpoint,
        process,
      };
      temporaryPath = join(canonicalDataDir, `.revo-control.${instanceId}.tmp`);
      await publishRecord(temporaryPath, join(canonicalDataDir, CONTROL_FILE), record);
      const lifecycleStop = new LifecycleStop(lifecycle);
      const shutdown = new HeldControlShutdown(progress, postgres, lifecycleStop, (onReleased) =>
        this.closeOwned(
          createdEndpoint,
          canonicalDataDir,
          instanceId,
          token,
          lease,
          lifecycleStop,
          onReleased,
        ),
      );
      const common = {
        kind: 'held' as const,
        canonicalDataDir,
        endpoint: createdEndpoint.endpoint,
        stopResult: createdEndpoint.stopResult,
        stopDelivery: createdEndpoint.stopDelivery,
        ...(progress ? { progress } : {}),
        ...(lifecycle ? { lifecycle } : {}),
        ...(postgres ? { startDatabase: postgres.start.bind(postgres) } : {}),
        close: () => shutdown.close(),
        ownershipReleased: () => shutdown.ownershipReleased,
      };
      if (request.databaseUrl !== undefined) {
        return { ...common, databaseKind: 'external' };
      }
      return {
        ...common,
        databaseKind: 'embedded',
        ...(postgres && 'prepareEmbeddedPostgres' in postgres
          ? { prepareEmbeddedPostgres: postgres.prepareEmbeddedPostgres.bind(postgres) }
          : {}),
      };
    } catch (error) {
      const failure = new PublishedControlError(
        'startup',
        await cleanupStartup(endpoint, temporaryPath, lease, lifecycle),
      );
      failure.cause = error;
      throw failure;
    }
  }

  private bindPostgres(
    request: OpenPublishedControlRequest,
    canonicalDataDir: string,
    progress: OwnedStartupProgress,
  ): BoundPostgres {
    if (request.databaseUrl !== undefined) {
      return this.externalPostgres.bind(request.databaseUrl, progress);
    }
    return this.postgres.bind(
      canonicalDataDir,
      progress,
      postgresLogPath(request, canonicalDataDir),
      request.version,
    );
  }

  private async closeOwned(
    endpoint: ListeningEndpoint,
    canonicalDataDir: string,
    instanceId: string,
    token: string,
    lease: Extract<Awaited<ReturnType<ServerOwnershipService['acquire']>>, { kind: 'held' }>,
    lifecycleStop: LifecycleStop,
    resolveOwnershipReleased: () => void,
  ): Promise<void> {
    const failures: ('endpoint' | 'metadata' | 'ownership')[] = [];
    try {
      await endpoint.close();
    } catch {
      failures.push('endpoint');
    }
    try {
      const discovered = await this.discovery.read(canonicalDataDir);
      if (
        discovered.kind === 'found' &&
        discovered.record.instanceId === instanceId &&
        discovered.record.token === token
      ) {
        await unlink(join(canonicalDataDir, CONTROL_FILE));
      } else if (discovered.kind === 'invalid' || discovered.kind === 'unavailable') {
        failures.push('metadata');
      }
    } catch {
      failures.push('metadata');
    }
    await lifecycleStop.finish(failures);
    try {
      await lease.release();
      resolveOwnershipReleased();
    } catch {
      failures.push('ownership');
    }
    if (failures.length > 0) {
      throw new PublishedControlError(
        'close',
        failures,
        failures.includes('ownership') ? 'unconfirmed' : 'released',
      );
    }
  }
}

async function cleanupStartup(
  endpoint: ListeningEndpoint | undefined,
  temporaryPath: string | undefined,
  lease: Extract<Awaited<ReturnType<ServerOwnershipService['acquire']>>, { kind: 'held' }>,
  lifecycle: ServerLifecycleSink | undefined,
) {
  const failures: ('endpoint' | 'metadata' | 'ownership')[] = [];
  if (endpoint) {
    try {
      await endpoint.close();
    } catch {
      failures.push('endpoint');
    }
  }
  if (temporaryPath) {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        failures.push('metadata');
      }
    }
  }
  await lifecycle?.emit('SERVER_START_FAILED').catch(() => undefined);
  await lifecycle?.close().catch(() => undefined);
  try {
    await lease.release();
  } catch {
    failures.push('ownership');
  }
  return failures;
}

async function publishRecord(temporaryPath: string, locatorPath: string, record: unknown) {
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized) > MAX_CONTROL_METADATA_BYTES) {
    throw new PublishedControlError('startup');
  }
  const file = await open(temporaryPath, 'wx', 0o600);
  try {
    await file.writeFile(serialized, 'utf8');
  } finally {
    await file.close();
  }
  await rename(temporaryPath, locatorPath);
}

async function openLifecycle(
  request: OpenPublishedControlRequest,
  canonicalDataDir: string,
): Promise<ServerLifecycleSink | undefined> {
  return openServerLifecycleStore(lifecycleConfiguration(request, canonicalDataDir));
}

function postgresLogPath(request: OpenPublishedControlRequest, canonicalDataDir: string) {
  const lifecycle = serverLifecyclePath(lifecycleConfiguration(request, canonicalDataDir));
  return join(dirname(lifecycle), 'postgres.log');
}

const lifecycleConfiguration = (
  request: OpenPublishedControlRequest,
  canonicalDataDir: string,
) => ({
  logDir: request.logDir,
  canonicalDataDir,
  channel: request.channel === 'alpha' ? ('alpha' as const) : ('stable' as const),
});

class LifecycleStop {
  private started = false;
  private failed = false;

  constructor(private readonly sink: ServerLifecycleSink | undefined) {}

  begin(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    emitLifecycle(this.sink, 'SERVER_STOPPING');
  }

  resourcesFailed(): void {
    this.failed = true;
  }

  async finish(failures: readonly unknown[]): Promise<void> {
    if (failures.length === 0 && !this.failed) {
      emitLifecycle(this.sink, 'SERVER_RESOURCES_STOPPED');
    } else {
      emitLifecycle(this.sink, 'SERVER_STOP_FAILED');
    }
    await this.sink?.close().catch(() => undefined);
  }
}

function emitLifecycle(
  sink: ServerLifecycleSink | undefined,
  code: Parameters<ServerLifecycleSink['emit']>[0],
): void {
  void sink?.emit(code).catch(() => undefined);
}

type ListeningEndpoint = Awaited<ReturnType<ControlEndpointService['listen']>>;

type BoundPostgres =
  | ReturnType<ExternalPostgresResourceService['bind']>
  | ReturnType<EmbeddedPostgresResourceService['bind']>;

class HeldControlShutdown {
  readonly ownershipReleased: Promise<void>;
  private resolveOwnershipReleased!: () => void;
  private finalClose: Promise<void> | undefined;
  private progressClose: Promise<void> | undefined;
  private finalState: 'pending' | 'released' | 'failed' = 'pending';

  constructor(
    private readonly progress: OwnedStartupProgress | undefined,
    private readonly postgres: BoundPostgres | undefined,
    private readonly lifecycleStop: LifecycleStop,
    private readonly closeOwned: (onOwnershipReleased: () => void) => Promise<void>,
  ) {
    this.ownershipReleased = new Promise<void>((resolve) => {
      this.resolveOwnershipReleased = resolve;
    });
  }

  async close(): Promise<void> {
    if (this.isReleased()) {
      await this.finalClose;
      return;
    }
    this.lifecycleStop.begin();
    const postgresClose = this.postgres?.close();
    this.progressClose ??= this.progress?.close();
    let postgresFailed = false;
    try {
      await postgresClose;
    } catch {
      postgresFailed = true;
      this.lifecycleStop.resourcesFailed();
    }
    if (postgresFailed) {
      if (!this.finalClose) {
        void this.finalize().catch(() => undefined);
      }
      if (this.isReleased()) {
        throw new PublishedControlError('close', [], 'released');
      }
      if (this.finalState === 'failed') {
        await this.finalClose;
      }
      throw new PublishedControlError('close', [], 'retained');
    }
    await this.finalize();
  }

  private isReleased(): boolean {
    return this.finalState === 'released';
  }

  private finalize(): Promise<void> {
    this.progressClose ??= this.progress?.close();
    if (!this.finalClose) {
      const finalClose = (async () => {
        await this.postgres?.settled();
        await this.progressClose;
        await this.closeOwned(this.resolveOwnershipReleased);
      })();
      this.finalClose = finalClose;
      void finalClose.then(
        () => {
          this.finalState = 'released';
        },
        () => {
          this.finalState = 'failed';
        },
      );
    }
    return this.finalClose;
  }
}
