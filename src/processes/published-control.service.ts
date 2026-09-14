import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { EmbeddedPostgresResourceService } from '../postgres/embedded-postgres-resource.service.js';
import { ExternalPostgresResourceService } from '../postgres/external-postgres-resource.service.js';
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

export class PublishedControlError extends Error {
  readonly code = 'PUBLISHED_CONTROL_ERROR';
  constructor(
    readonly phase: 'startup' | 'close',
    readonly cleanupFailures: readonly ('endpoint' | 'metadata' | 'ownership')[] = [],
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
        identity: { version: request.version, channel: request.channel, canonicalDataDir, process },
      });
      endpoint = createdEndpoint;
      const progress = request.startupProgress
        ? new OwnedStartupProgress(this.progressJournal, canonicalDataDir, request.startupProgress)
        : undefined;
      const postgres = progress
        ? request.databaseUrl !== undefined
          ? this.externalPostgres.bind(request.databaseUrl, progress)
          : this.postgres.bind(canonicalDataDir, progress)
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
      let finalClose: Promise<void> | undefined;
      let progressClose: Promise<void> | undefined;
      let finalState: 'pending' | 'success' | 'failure' = 'pending';
      const finalize = () => {
        progressClose ??= progress?.close();
        if (!finalClose) {
          finalClose = (async () => {
            await postgres?.settled();
            await progressClose;
            await this.closeOwned(createdEndpoint, canonicalDataDir, instanceId, token, lease);
          })();
          void finalClose.then(
            () => {
              finalState = 'success';
            },
            () => {
              finalState = 'failure';
            },
          );
        }
        return finalClose;
      };
      const close = async () => {
        const postgresClose = postgres?.close();
        progressClose ??= progress?.close();
        try {
          await postgresClose;
        } catch {
          if (finalClose) {
            if (finalState !== 'pending') {
              await finalClose;
              return;
            }
            throw new PublishedControlError('close');
          }
          void finalize().catch(() => undefined);
          throw new PublishedControlError('close');
        }
        await finalize();
      };
      const common = {
        kind: 'held' as const,
        endpoint: createdEndpoint.endpoint,
        stopResult: createdEndpoint.stopResult,
        ...(progress ? { progress } : {}),
        ...(postgres ? { startDatabase: postgres.start.bind(postgres) } : {}),
        close,
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
        await cleanupStartup(endpoint, temporaryPath, lease),
      );
    }
  }

  private async closeOwned(
    endpoint: Awaited<ReturnType<ControlEndpointService['listen']>>,
    canonicalDataDir: string,
    instanceId: string,
    token: string,
    lease: Extract<Awaited<ReturnType<ServerOwnershipService['acquire']>>, { kind: 'held' }>,
  ): Promise<void> {
    let failed = false;
    try {
      await endpoint.close();
    } catch {
      failed = true;
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
        failed = true;
      }
    } catch {
      failed = true;
    }
    try {
      await lease.release();
    } catch {
      failed = true;
    }
    if (failed) {
      throw new PublishedControlError('close');
    }
  }
}

async function cleanupStartup(
  endpoint: Awaited<ReturnType<ControlEndpointService['listen']>> | undefined,
  temporaryPath: string | undefined,
  lease: Extract<Awaited<ReturnType<ServerOwnershipService['acquire']>>, { kind: 'held' }>,
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
