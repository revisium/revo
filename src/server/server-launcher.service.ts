import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Inject, Injectable } from '@nestjs/common';

import { ConfigurationResolver } from '../configuration/configuration-resolver.js';
import type {
  ConfigurationInput,
  RevoConfiguration,
} from '../configuration/configuration.types.js';
import { buildCoreChildEnvironment } from '../core-host/core-child-environment.js';
import type { ActivationBinding } from '../installation/activation-record.js';
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

export type ServerLaunchResult = ServerStatus | StartedServer;

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
  ) {}

  async launch(request: Readonly<ServerLaunchRequest>): Promise<ServerLaunchResult> {
    const resolved = await this.configuration.resolve(request);
    const current = await this.status.read(resolved.layout.dataDir);
    if (current.kind !== 'stopped') {
      if (current.kind === 'running' && request.onProgress) {
        await this.observer.reused(
          current.status.publicUrl,
          request.onProgress,
          randomBytes(16).toString('hex'),
        );
      }
      return current;
    }
    const environment = buildCoreChildEnvironment(request.env).env;
    const operationId = randomBytes(16).toString('hex');
    const deadline = Date.now() + resolved.startupTimeout;
    const launched = await this.processes.start(
      {
        cwd: resolved.installDir,
        entry: SERVER_ENTRY,
        env: environment,
        executable: process.execPath,
      },
      { graceMs: GRACE_MILLISECONDS, killWaitMs: KILL_WAIT_MILLISECONDS, signal: request.signal },
    );
    const attempt = new ServerLaunchAttempt(launched).start(
      this.startMessage(request, resolved, operationId, environment),
      { deadline, signal: request.signal },
    );
    return request.onProgress
      ? this.observer.observe(attempt, {
          dataDir: resolved.layout.dataDir,
          operationId,
          deadline,
          sink: request.onProgress,
        })
      : attempt;
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
        ...activationFromEnvironment(request.env),
      },
      environment,
    };
  }
}

function activationFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): { readonly activation: ActivationBinding } | Record<string, never> {
  const channelRoot = env.REVO_ACTIVATION_CHANNEL_ROOT;
  const generationId = env.REVO_ACTIVATION_GENERATION_ID;
  if (channelRoot === undefined && generationId === undefined) {
    return {};
  }
  if (
    channelRoot === undefined ||
    generationId === undefined ||
    !channelRoot.startsWith('/') ||
    !/^[a-f0-9]{64}$/u.test(generationId)
  ) {
    throw new Error('activation binding is invalid');
  }
  return { activation: { channelRoot, generationId } };
}
