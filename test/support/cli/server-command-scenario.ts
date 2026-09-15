// oxlint-disable-next-line import/no-unassigned-import -- decorators require this side effect first
import 'reflect-metadata';
import { Module, type Type } from '@nestjs/common';
import { CommandFactory } from 'nest-commander';

import { cliFailure } from '../../../src/cli/cli-error.js';
import { ServerCommand } from '../../../src/cli/commands/server.command.js';
import { OutputService } from '../../../src/cli/output.service.js';
import { PackageMetadataService } from '../../../src/cli/package-metadata.service.js';
import { ServerCommandService } from '../../../src/cli/server-command.service.js';
import {
  SERVER_LOGS_WAIT,
  ServerLogsCommandService,
} from '../../../src/cli/server-logs-command.service.js';
import { ConfigurationResolver } from '../../../src/configuration/configuration-resolver.js';
import type {
  ConfigurationInput,
  RevoConfiguration,
} from '../../../src/configuration/configuration.types.js';
import { resolveRevoLayout } from '../../../src/layout.js';
import { waitForFollowPoll } from '../../../src/server-logs/follow.js';
import {
  ServerLauncherService,
  type ServerLaunchRequest,
  type ServerLaunchResult,
} from '../../../src/server/server-launcher.service.js';
import {
  ServerStatusService,
  type ServerStatus,
} from '../../../src/server/server-status.service.js';
import {
  ServerStopService,
  type ServerStopResult,
} from '../../../src/server/server-stop.service.js';

type SignalListeners = { readonly sigint: number; readonly sigterm: number };
type PendingLaunch = { listeners: SignalListeners; stderr: string; stdout: string };

const FIXTURE_LAYOUT = resolveRevoLayout({
  channel: 'stable',
  env: {},
  homeDir: '/fixture',
  platform: 'linux',
});
const FIXTURE_CONFIGURATION: Readonly<RevoConfiguration> = Object.freeze({
  channel: 'stable',
  configPath: '/fixture/config.json',
  host: '127.0.0.1',
  installDir: '/fixture/install',
  layout: Object.freeze(FIXTURE_LAYOUT),
  logDir: '/fixture/logs',
  port: 3210,
  publicUrl: 'http://127.0.0.1:3210',
  startupTimeout: 180_000,
});
const PORTS = [
  ConfigurationResolver,
  OutputService,
  PackageMetadataService,
  ServerLauncherService,
  ServerStatusService,
  ServerStopService,
];

export const FIXTURE_DATA_DIR = FIXTURE_LAYOUT.dataDir;

export interface ServerCommandFixture {
  readonly launch?: (request: Readonly<ServerLaunchRequest>) => Promise<ServerLaunchResult>;
  readonly platform?: NodeJS.Platform;
  readonly raise?: 'SIGINT' | 'SIGTERM';
  readonly resolve?: () => Promise<Readonly<RevoConfiguration>>;
  readonly status?: ServerStatus;
  readonly stop?: ServerStopResult;
  readonly version?: string;
}

export function serverStatus(kind: ServerStatus['kind']): ServerStatus {
  return kind === 'missing' || kind === 'stopped' || kind === 'unknown'
    ? { kind }
    : { kind, status: { phase: kind } };
}

export class ServerCommandScenario {
  private constructor() {}

  static async run(
    args: readonly string[],
    fixture: Readonly<ServerCommandFixture> = {},
  ): Promise<ServerCommandResult> {
    const recorder = new CommandRecorder(fixture);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const argv = process.argv;
    process.argv = ['node', 'revo', ...args];
    stubPlatform(fixture.platform);
    try {
      await CommandFactory.run(recorder.module(), {
        cliName: 'revo',
        errorHandler: rethrow,
        logger: false,
        outputConfiguration: { writeErr: () => undefined, writeOut: (t) => recorder.write(t) },
        serviceErrorHandler: rethrow,
        version: '0.0.0',
      });
      return recorder.result(0);
    } catch (error) {
      const failure = cliFailure(error);
      if (failure.message !== undefined) {
        recorder.writeError(failure.message);
      }
      return recorder.result(failure.exitCode);
    } finally {
      process.argv = argv;
      if (platform !== undefined) {
        Object.defineProperty(process, 'platform', platform);
      }
    }
  }
}

export type ServerCommandResult = ReturnType<CommandRecorder['result']>;

/** Replaces every launcher, status, stop, metadata, and output port of the real command wiring. */
class CommandRecorder {
  readonly cliName = 'revo';
  readonly launches: Readonly<ServerLaunchRequest>[] = [];
  readonly reads: string[] = [];
  readonly resolves: Readonly<ConfigurationInput>[] = [];
  readonly stops: { dataDir: string; timeoutMs: number }[] = [];

  private readonly baseline = signalListeners();
  private readonly errors: string[] = [];
  private readonly outputs: string[] = [];
  private pendingLaunch: PendingLaunch | undefined;

  constructor(private readonly fixture: Readonly<ServerCommandFixture>) {}

  get version(): string {
    return this.fixture.version ?? '0.0.0';
  }

  module(): Type<unknown> {
    @Module({
      providers: [
        ServerCommandService,
        ServerLogsCommandService,
        ...ServerCommand.registerWithSubCommands(),
        ...PORTS.map((provide) => ({ provide, useValue: this })),
        { provide: SERVER_LOGS_WAIT, useValue: waitForFollowPoll },
      ],
    })
    // oxlint-disable-next-line typescript/no-extraneous-class -- Nest test module metadata
    class ServerCommandTestModule {}

    return ServerCommandTestModule;
  }

  result(exitCode: number) {
    return {
      exitCode,
      launches: this.launches,
      listeners: this.added(),
      pending: this.pendingLaunch,
      reads: this.reads,
      resolves: this.resolves,
      stderr: this.errors.join(''),
      stdout: this.outputs.join(''),
      stops: this.stops,
    };
  }

  write(message: string): void {
    this.outputs.push(line(message));
  }

  writeError(message: string): void {
    this.errors.push(line(message));
  }

  async launch(request: Readonly<ServerLaunchRequest>): Promise<ServerLaunchResult> {
    this.launches.push(request);
    this.pendingLaunch = {
      listeners: this.added(),
      stderr: this.errors.join(''),
      stdout: this.outputs.join(''),
    };
    this.raise();
    return this.fixture.launch?.(request) ?? serverStatus('stopped');
  }

  async resolve(input: Readonly<ConfigurationInput>): Promise<Readonly<RevoConfiguration>> {
    this.resolves.push(input);
    return this.fixture.resolve?.() ?? FIXTURE_CONFIGURATION;
  }

  async read(dataDir: string): Promise<ServerStatus> {
    this.reads.push(dataDir);
    return this.fixture.status ?? serverStatus('stopped');
  }

  async stop(dataDir: string, timeoutMs: number): Promise<ServerStopResult> {
    this.stops.push({ dataDir, timeoutMs });
    return this.fixture.stop ?? { kind: 'completed' };
  }

  /** Invokes only the listeners the command boundary added on top of the ambient ones. */
  private raise(): void {
    const signal = this.fixture.raise;
    if (signal === undefined) {
      return;
    }
    const ambient = signal === 'SIGINT' ? this.baseline.sigint : this.baseline.sigterm;
    for (const listener of process.listeners(signal).slice(ambient)) {
      listener(signal);
    }
  }

  private added(): SignalListeners {
    const { sigint, sigterm } = signalListeners();
    return { sigint: sigint - this.baseline.sigint, sigterm: sigterm - this.baseline.sigterm };
  }
}

const line = (message: string): string => (message.endsWith('\n') ? message : `${message}\n`);

const rethrow = (error: Error): never => {
  throw error;
};

const signalListeners = (): SignalListeners => ({
  sigint: process.listenerCount('SIGINT'),
  sigterm: process.listenerCount('SIGTERM'),
});

const stubPlatform = (platform: NodeJS.Platform | undefined): void => {
  if (platform !== undefined) {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  }
};
