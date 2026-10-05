import { homedir } from 'node:os';
import process from 'node:process';

import { Inject, Injectable } from '@nestjs/common';

import { ConfigurationResolver } from '../configuration/configuration-resolver.js';
import type {
  ConfigurationFlags,
  ConfigurationInput,
} from '../configuration/configuration.types.js';
import { readServerLogTail } from '../server-logs/server-log.js';
import {
  ServerLauncherService,
  type ServerLaunchContext,
  type ServerLaunchResult,
} from '../server/server-launcher.service.js';
import type { ServerProgressSink } from '../server/server-startup-observer.js';
import { ServerStatusService, type ServerStatus } from '../server/server-status.service.js';
import { SERVER_STOP_CONFIRMATION_MS, ServerStopService } from '../server/server-stop.service.js';
import { CliUsageError } from './cli-error.js';
import { OutputService } from './output.service.js';
import { PackageMetadataService } from './package-metadata.service.js';
import { startNotPerformed } from './server-public-origin.js';

const DIAGNOSTICS: Readonly<Record<string, string>> = {
  START_BUSY: 'Server start is busy.',
  START_CANCELLED: 'Server start was cancelled.',
  START_FAILED: 'Server start failed.',
  START_OUTCOME_UNKNOWN: 'Server start outcome is unknown.',
  'revo.process.cancelled': 'Server start was cancelled.',
};
const LOGGED_FAILURES: ReadonlySet<string> = new Set(['START_FAILED', 'START_OUTCOME_UNKNOWN']);
const CLEANUP: Readonly<Record<string, string>> = {
  retained: ' Resources may remain active.',
  unconfirmed: ' Cleanup could not be confirmed.',
};
const UNAVAILABLE = 'Server status is unavailable';
const STOPPABLE: ReadonlySet<ServerStatus['kind']> = new Set([
  'running',
  'starting',
  'stopping',
  'failed',
]);

export interface ServerStartFlags extends ConfigurationFlags {
  readonly progress?: string;
}

@Injectable()
export class ServerCommandService {
  constructor(
    @Inject(ServerLauncherService)
    private readonly launcher: Pick<ServerLauncherService, 'launch' | 'launchWithConfiguration'>,
    @Inject(ConfigurationResolver)
    private readonly configuration: Pick<ConfigurationResolver, 'resolve'>,
    @Inject(ServerStatusService)
    private readonly serverStatus: Pick<ServerStatusService, 'read'>,
    @Inject(ServerStopService)
    private readonly serverStop: Pick<ServerStopService, 'stop'>,
    @Inject(PackageMetadataService)
    private readonly metadata: Pick<PackageMetadataService, 'version'>,
    @Inject(OutputService)
    private readonly output: Pick<OutputService, 'write' | 'progress'>,
  ) {}

  async start(flags: Readonly<ServerStartFlags>): Promise<void> {
    const { progress, ...configuration } = flags;
    if (progress !== undefined && progress !== 'jsonl') {
      throw new CliUsageError('Startup progress format must be jsonl.');
    }
    if (progress === undefined) {
      this.presentStartOutcome(await this.ensureRunning(configuration));
      return;
    }
    const output = this.output.progress();
    try {
      const outcome = await this.launch(this.input(configuration), output.sink);
      if (outcome.kind !== 'started' && outcome.kind !== 'running') {
        this.presentStartOutcome(outcome);
      }
    } finally {
      output.close();
    }
  }

  async ensureRunning(flags: Readonly<ConfigurationFlags>): Promise<ServerLaunchResult> {
    return this.launch(this.input(flags));
  }

  async ensureRunningWithConfiguration(
    flags: Readonly<ConfigurationFlags>,
  ): Promise<ServerLaunchContext> {
    const input = this.input(flags);
    return this.withSignal(input, (signal) =>
      this.launcher.launchWithConfiguration({ ...input, signal }),
    );
  }

  private presentStartOutcome(outcome: ServerLaunchResult): void {
    if (outcome.kind === 'started') {
      this.output.write(`Server started at ${outcome.url}.`);
    } else if (outcome.kind === 'running') {
      this.output.write('Server is already running.');
    } else {
      throw startNotPerformed(outcome);
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
    if (!STOPPABLE.has(current.kind)) {
      throw new Error(`${UNAVAILABLE}; stop was not performed.`);
    }
    const stopped = await this.serverStop.stop(dataDir, SERVER_STOP_CONFIRMATION_MS);
    if (stopped.kind !== 'completed') {
      throw new Error('Server stop could not be confirmed.');
    }
    this.output.write('Server stopped.');
  }

  /** Owns the interactive lifetime of one launch: one controller, one attempt, no retry. */
  private async launch(
    input: Readonly<ConfigurationInput>,
    onProgress?: ServerProgressSink,
  ): Promise<ServerLaunchResult> {
    return this.withSignal(input, (signal) =>
      this.launcher.launch({
        ...input,
        signal,
        ...(onProgress ? { onProgress } : {}),
      }),
    );
  }

  private async withSignal<T>(
    input: Readonly<ConfigurationInput>,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
    try {
      return await operation(controller.signal);
    } catch (error) {
      throw await this.withServerLog(input, diagnose(error), error);
    } finally {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    }
  }

  private async withServerLog(
    input: Readonly<ConfigurationInput>,
    diagnosed: unknown,
    cause: unknown,
  ): Promise<unknown> {
    const code = cause instanceof Error ? Reflect.get(cause, 'code') : undefined;
    if (!(diagnosed instanceof Error) || typeof code !== 'string' || !LOGGED_FAILURES.has(code)) {
      return diagnosed;
    }
    const tail = await this.configuration
      .resolve(input)
      .then(({ channel, layout, logDir }) =>
        readServerLogTail({ channel, dataDir: layout.dataDir, logDir }),
      )
      .catch(() => undefined);
    if (!tail) {
      return diagnosed;
    }
    const lines = [diagnosed.message, `Server log: ${tail.path}`];
    if (tail.lines.length > 0) {
      lines.push(`Last ${String(tail.lines.length)} log lines:`, ...tail.lines);
    }
    return new Error(lines.join('\n'));
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
