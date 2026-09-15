import { homedir } from 'node:os';
import process from 'node:process';

import { Inject, Injectable } from '@nestjs/common';

import { ConfigurationResolver } from '../configuration/configuration-resolver.js';
import type {
  ConfigurationFlags,
  ConfigurationInput,
} from '../configuration/configuration.types.js';
import { DEFAULT_CONTROL_LIMITS } from '../processes/control-endpoint.types.js';
import {
  ServerLauncherService,
  type ServerLaunchResult,
} from '../server/server-launcher.service.js';
import { ServerStatusService, type ServerStatus } from '../server/server-status.service.js';
import { ServerStopService } from '../server/server-stop.service.js';
import { OutputService } from './output.service.js';
import { PackageMetadataService } from './package-metadata.service.js';

const DIAGNOSTICS: Readonly<Record<string, string>> = {
  START_BUSY: 'Server start is busy.',
  START_CANCELLED: 'Server start was cancelled.',
  START_FAILED: 'Server start failed.',
  START_OUTCOME_UNKNOWN: 'Server start outcome is unknown.',
  'revo.process.cancelled': 'Server start was cancelled.',
};
const CLEANUP: Readonly<Record<string, string>> = {
  retained: ' Resources may remain active.',
  unconfirmed: ' Cleanup could not be confirmed.',
};
const UNAVAILABLE = 'Server status is unavailable';
const STOPPABLE: readonly ServerStatus['kind'][] = ['running', 'starting', 'stopping', 'failed'];

@Injectable()
export class ServerCommandService {
  constructor(
    @Inject(ServerLauncherService)
    private readonly launcher: Pick<ServerLauncherService, 'launch'>,
    @Inject(ConfigurationResolver)
    private readonly configuration: Pick<ConfigurationResolver, 'resolve'>,
    @Inject(ServerStatusService)
    private readonly serverStatus: Pick<ServerStatusService, 'read'>,
    @Inject(ServerStopService)
    private readonly serverStop: Pick<ServerStopService, 'stop'>,
    @Inject(PackageMetadataService)
    private readonly metadata: Pick<PackageMetadataService, 'version'>,
    @Inject(OutputService)
    private readonly output: Pick<OutputService, 'write'>,
  ) {}

  async start(flags: Readonly<ConfigurationFlags>): Promise<void> {
    const outcome = await this.launch(this.input(flags));
    if (outcome.kind === 'started') {
      this.output.write(`Server started at ${outcome.url}.`);
    } else if (outcome.kind === 'running') {
      this.output.write('Server is already running.');
    } else if (outcome.kind === 'stopped') {
      throw new Error('Server did not start.');
    } else if (outcome.kind === 'unknown' || outcome.kind === 'missing') {
      throw new Error(`${UNAVAILABLE}; start was not performed.`);
    } else {
      throw new Error(`Server is ${outcome.kind}; start was not performed.`);
    }
  }

  async status(): Promise<void> {
    const { current } = await this.inspect();
    if (current.kind === 'failed') {
      throw new Error('Server is failed.');
    }
    if (current.kind === 'unknown' || current.kind === 'missing') {
      throw new Error(`${UNAVAILABLE}.`);
    }
    this.output.write(`Server is ${current.kind}.`);
  }

  async stop(): Promise<void> {
    const { current, dataDir } = await this.inspect();
    if (current.kind === 'stopped') {
      this.output.write('Server is already stopped.');
      return;
    }
    if (!STOPPABLE.includes(current.kind)) {
      throw new Error(`${UNAVAILABLE}; stop was not performed.`);
    }
    const stopped = await this.serverStop.stop(dataDir, DEFAULT_CONTROL_LIMITS.timeoutMs);
    if (stopped.kind !== 'completed') {
      throw new Error('Server stop could not be confirmed.');
    }
    this.output.write('Server stopped.');
  }

  /** Owns the interactive lifetime of one launch: one controller, one attempt, no retry. */
  private async launch(input: Readonly<ConfigurationInput>): Promise<ServerLaunchResult> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
    try {
      return await this.launcher.launch({ ...input, signal: controller.signal });
    } catch (error) {
      throw diagnose(error);
    } finally {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    }
  }

  private async inspect(): Promise<{ current: ServerStatus; dataDir: string }> {
    const { layout } = await this.configuration.resolve(this.input({}));
    const dataDir = layout.dataDir;

    return { current: await this.serverStatus.read(dataDir), dataDir };
  }

  private input(flags: Readonly<ConfigurationFlags>): ConfigurationInput {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error('Server commands are unsupported on this platform.');
    }

    return {
      env: { ...process.env },
      flags,
      homeDir: homedir(),
      packageVersion: this.metadata.version,
      platform: process.platform,
    };
  }
}

/** Replaces launch transport failures with the fixed operator-facing diagnostics. */
function diagnose(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const code = Reflect.get(error, 'code');
  const diagnostic = typeof code === 'string' ? DIAGNOSTICS[code] : undefined;
  if (diagnostic === undefined) {
    return error;
  }
  const cleanup = Reflect.get(error, 'cleanup');
  const suffix = typeof cleanup === 'string' ? (CLEANUP[cleanup] ?? '') : '';

  return new Error(`${diagnostic}${suffix}`);
}
