import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Inject, Injectable } from '@nestjs/common';

import { ConfigurationResolver } from '../configuration/configuration-resolver.js';
import type {
  ConfigurationInput,
  RevoConfiguration,
} from '../configuration/configuration.types.js';
import { buildCoreChildEnvironment } from '../core-host/core-child-environment.js';
import { ServerOwnershipService } from '../processes/server-ownership.service.js';
import { SERVER_HOST_PROTOCOL, type ServerHostStartMessage } from './server-host-protocol.js';
import { ServerLaunchAttempt, type StartedServer } from './server-launch-attempt.js';
import { ServerLaunchProcessService } from './server-launch-process.service.js';
import { ServerStartupObserver, type ServerProgressSink } from './server-startup-observer.js';
import { ServerStatusService, type ServerStatus } from './server-status.service.js';

const SERVER_ENTRY = fileURLToPath(new URL('../bin/revo-server.js', import.meta.url));
const GRACE_MILLISECONDS = 500;
const KILL_WAIT_MILLISECONDS = 2_500;

export interface ServerLaunchRequest extends ConfigurationInput {
  readonly signal: AbortSignal;
  readonly onProgress?: ServerProgressSink;
}

/** An unreachable server that still holds the data directory's ownership lock. */
export interface OwnedDataDirectory {
  readonly kind: 'owned';
}

export type ServerLaunchResult = ServerStatus | StartedServer | OwnedDataDirectory;

export interface ServerLaunchContext {
  readonly configuration: Readonly<RevoConfiguration>;
  readonly outcome: ServerLaunchResult;
}

@Injectable()
export class ServerLauncherService {
  constructor(
    @Inject(ConfigurationResolver)
    private readonly configuration: Pick<
      ConfigurationResolver,
      'resolve'
    > = new ConfigurationResolver(),
    @Inject(ServerStatusService)
    private readonly status: Pick<ServerStatusService, 'read'> = new ServerStatusService(),
    @Inject(ServerLaunchProcessService)
    private readonly processes: Pick<
      ServerLaunchProcessService,
      'start'
    > = new ServerLaunchProcessService(),
    @Inject(ServerStartupObserver)
    private readonly observer = new ServerStartupObserver(),
    @Inject(ServerOwnershipService)
    private readonly ownership: Pick<
      ServerOwnershipService,
      'inspect'
    > = new ServerOwnershipService(),
  ) {}

  async launch(request: Readonly<ServerLaunchRequest>): Promise<ServerLaunchResult> {
    return (await this.launchWithConfiguration(request)).outcome;
  }

  async launchWithConfiguration(
    request: Readonly<ServerLaunchRequest>,
  ): Promise<ServerLaunchContext> {
    const resolved = await this.configuration.resolve(request);
    const current = await this.blockingServer(resolved.layout.dataDir);
    if (current) {
      if (current.kind === 'running' && request.onProgress) {
        await this.observer.reused(
          current.status.publicUrl,
          request.onProgress,
          randomBytes(16).toString('hex'),
        );
      }
      return { configuration: resolved, outcome: current };
    }
    const environment = buildCoreChildEnvironment(request.env).env;
    const operationId = randomBytes(16).toString('hex');
    const deadline = Date.now() + resolved.startupTimeout;
    const launched = await this.processes.start(
      {
        cwd: dirname(SERVER_ENTRY),
        entry: SERVER_ENTRY,
        env: environment,
        executable: process.execPath,
        log: {
          channel: resolved.channel,
          dataDir: resolved.layout.dataDir,
          logDir: resolved.logDir,
        },
      },
      { graceMs: GRACE_MILLISECONDS, killWaitMs: KILL_WAIT_MILLISECONDS, signal: request.signal },
    );
    const attempt = new ServerLaunchAttempt(launched).start(
      this.startMessage(request, resolved, operationId, environment),
      { deadline, signal: request.signal },
    );
    const outcome = await (request.onProgress
      ? this.observer.observe(attempt, {
          dataDir: resolved.layout.dataDir,
          operationId,
          deadline,
          sink: request.onProgress,
        })
      : attempt);
    return { configuration: resolved, outcome };
  }

  /** An unreachable server blocks a new one until nothing owns its data directory. */
  private async blockingServer(
    dataDir: string,
  ): Promise<ServerStatus | OwnedDataDirectory | undefined> {
    const current = await this.status.read(dataDir);
    if (current.kind === 'stopped') {
      return undefined;
    }
    if (current.kind !== 'unknown') {
      return current;
    }
    const ownership = await this.ownership.inspect(dataDir);
    if (ownership.kind === 'free') {
      return undefined;
    }
    return ownership.kind === 'busy' ? { kind: 'owned' } : current;
  }

  private startMessage(
    request: Readonly<ServerLaunchRequest>,
    resolved: Readonly<RevoConfiguration>,
    operationId: string,
    environment: Readonly<Record<string, string>>,
  ): ServerHostStartMessage {
    return {
      protocol: SERVER_HOST_PROTOCOL,
      type: 'start',
      operationId,
      mode: 'detached',
      configuration: {
        channel: resolved.channel,
        dataDir: resolved.layout.dataDir,
        ...(resolved.databaseUrl === undefined ? {} : { databaseUrl: resolved.databaseUrl }),
        host: resolved.host,
        logDir: resolved.logDir,
        port: resolved.port,
        publicUrl: resolved.publicUrl,
        runtimeDir: resolved.layout.runtimeDir,
        startupTimeout: resolved.startupTimeout,
        version: request.packageVersion,
      },
      environment,
    };
  }
}
