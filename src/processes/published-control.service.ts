import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { EmbeddedPostgresResourceService } from '../postgres/embedded-postgres-resource.service.js';
import { ExternalPostgresResourceService } from '../postgres/external-postgres-resource.service.js';
import type { ServerLifecycleSink } from '../server-logs/server-lifecycle.types.js';
import { openServerLifecycleStore } from '../server-logs/store.service.js';
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
    const lifecycle = await openServerLifecycleStore({
      logDir: request.logDir,
      canonicalDataDir,
      channel: request.channel === 'alpha' ? 'alpha' : 'stable',
    });
    emitLifecycle(lifecycle, 'SERVER_STARTING');
    const instanceId = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('hex');
    let endpoint: Awaited<ReturnType<ControlEndpointService['listen']>> | undefined;
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
      let postgres:
        | ReturnType<ExternalPostgresResourceService['bind']>
        | ReturnType<EmbeddedPostgresResourceService['bind']>
        | undefined;
      if (progress) {
        if (request.databaseUrl !== undefined) {
          postgres = this.externalPostgres.bind(request.databaseUrl, progress);
        } else {
          postgres = this.postgres.bind(canonicalDataDir, progress);
        }
      }
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
      let finalClose: Promise<void> | undefined;
      let progressClose: Promise<void> | undefined;
      const lifecycleStop = new LifecycleStop(lifecycle);
      let finalState: 'pending' | 'released' | 'failed' = 'pending';
      let resolveOwnershipReleased!: () => void;
      const ownershipReleased = new Promise<void>((resolve) => {
        resolveOwnershipReleased = resolve;
      });
      const isReleased = () => finalState === 'released';
      const finalize = () => {
        progressClose ??= progress?.close();
        if (!finalClose) {
          finalClose = (async () => {
            await postgres?.settled();
            await progressClose;
            await this.closeOwned(
              createdEndpoint,
              canonicalDataDir,
              instanceId,
              token,
              lease,
              lifecycleStop,
              resolveOwnershipReleased,
            );
          })();
          void finalClose.then(
            () => {
              finalState = 'released';
            },
            () => {
              finalState = 'failed';
            },
          );
        }
        return finalClose;
      };
      const close = async () => {
        if (isReleased()) {
          await finalClose;
          return;
        }
        lifecycleStop.begin();
        const postgresClose = postgres?.close();
        progressClose ??= progress?.close();
        let postgresFailed = false;
        try {
          await postgresClose;
        } catch {
          postgresFailed = true;
          lifecycleStop.resourcesFailed();
        }
        if (postgresFailed) {
          if (!finalClose) {
            void finalize().catch(() => undefined);
          }
          if (isReleased()) {
            throw new PublishedControlError('close', [], 'released');
          }
          if (finalState === 'failed') {
            await finalClose;
          }
          throw new PublishedControlError('close', [], 'retained');
        }
        await finalize();
      };
      const common = {
        kind: 'held' as const,
        canonicalDataDir,
        endpoint: createdEndpoint.endpoint,
        stopResult: createdEndpoint.stopResult,
        stopDelivery: createdEndpoint.stopDelivery,
        ...(progress ? { progress } : {}),
        ...(lifecycle ? { lifecycle } : {}),
        ...(postgres ? { startDatabase: postgres.start.bind(postgres) } : {}),
        close,
        ownershipReleased: () => ownershipReleased,
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
    } catch {
      throw new PublishedControlError(
        'startup',
        await cleanupStartup(endpoint, temporaryPath, lease, lifecycle),
      );
    }
  }

  private async closeOwned(
    endpoint: Awaited<ReturnType<ControlEndpointService['listen']>>,
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
  endpoint: Awaited<ReturnType<ControlEndpointService['listen']>> | undefined,
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

const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;

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
