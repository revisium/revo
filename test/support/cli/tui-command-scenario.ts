// oxlint-disable-next-line import/no-unassigned-import -- decorators require this side effect first
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { RunRevoTuiOptions } from '@revisium/revo-tui/launcher';
import { CommandFactory } from 'nest-commander';

import { cliFailure } from '../../../src/cli/cli-error.js';
import { TuiCommand } from '../../../src/cli/commands/tui.command.js';
import { ServerCommandService } from '../../../src/cli/server-command.service.js';
import {
  TUI_LAUNCHER,
  TUI_TERMINAL,
  TuiCommandService,
  type TuiTerminal,
} from '../../../src/cli/tui-command.service.js';
import type {
  ConfigurationFlags,
  RevoConfiguration,
} from '../../../src/configuration/configuration.types.js';
import { resolveRevoLayout } from '../../../src/layout.js';
import type {
  ServerLaunchContext,
  ServerLaunchResult,
} from '../../../src/server/server-launcher.service.js';

const FIXTURE_DATA_DIR = '/fixture/stable-data';
const FIXTURE_CONFIGURATION = (
  channel: 'stable' | 'alpha',
  dataDir: string,
): Readonly<RevoConfiguration> => ({
  channel,
  configPath: '/fixture/config.json',
  host: '127.0.0.1',
  installDir: '/fixture/install',
  layout: {
    ...resolveRevoLayout({ channel, env: {}, homeDir: '/fixture', platform: 'linux' }),
    dataDir,
  },
  logDir: '/fixture/logs',
  port: channel === 'alpha' ? 3211 : 3210,
  publicUrl: `http://127.0.0.1:${channel === 'alpha' ? '3211' : '3210'}`,
  startupTimeout: 180_000,
});

export interface TuiCommandFixture {
  readonly stdinTTY?: boolean;
  readonly stdoutTTY?: boolean;
  readonly outcome?: ServerLaunchResult;
  readonly resolvedChannel?: 'stable' | 'alpha';
  readonly resolvedDataDir?: string;
  readonly exitCode?: number;
  readonly launchError?: Error;
}

export class TuiCommandScenario {
  private constructor() {}

  static async run(args: readonly string[], fixture: Readonly<TuiCommandFixture> = {}) {
    const ensures: Readonly<ConfigurationFlags>[] = [];
    const launches: Readonly<RunRevoTuiOptions>[] = [];
    const events: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const server = {
      ensureRunningWithConfiguration: async (
        flags: Readonly<ConfigurationFlags>,
      ): Promise<ServerLaunchContext> => {
        events.push('ensure');
        ensures.push(flags);
        return {
          configuration: FIXTURE_CONFIGURATION(
            fixture.resolvedChannel ?? 'stable',
            fixture.resolvedDataDir ?? FIXTURE_DATA_DIR,
          ),
          outcome: fixture.outcome ?? { kind: 'started', url: 'https://revo.example/' },
        };
      },
    };
    const launch: typeof runLauncher = async (options) => {
      events.push('launch');
      launches.push(options);
      if (fixture.launchError !== undefined) {
        throw fixture.launchError;
      }
      return fixture.exitCode ?? 0;
    };
    const terminal = (): TuiTerminal => ({
      stdin: fixture.stdinTTY ?? true,
      stdout: fixture.stdoutTTY ?? true,
    });

    @Module({
      providers: [
        TuiCommand,
        TuiCommandService,
        { provide: ServerCommandService, useValue: server },
        { provide: TUI_LAUNCHER, useValue: launch },
        { provide: TUI_TERMINAL, useValue: terminal },
      ],
    })
    // oxlint-disable-next-line typescript/no-extraneous-class -- Nest test module metadata
    class TestModule {}

    const argv = process.argv;
    process.argv = ['node', 'revo', ...args];
    let exitCode = 0;
    try {
      await CommandFactory.run(TestModule, {
        cliName: 'revo',
        errorHandler: rethrow,
        logger: false,
        outputConfiguration: {
          writeErr: () => undefined,
          writeOut: (text) => stdout.push(text),
        },
        serviceErrorHandler: rethrow,
      });
    } catch (error) {
      const failure = cliFailure(error);
      exitCode = failure.exitCode;
      if (failure.message !== undefined) {
        stderr.push(`${failure.message}\n`);
      }
    } finally {
      process.argv = argv;
    }

    return {
      ensures,
      events,
      exitCode,
      launches,
      stderr: stderr.join(''),
      stdout: stdout.join(''),
    };
  }
}

type Launcher = (options: RunRevoTuiOptions) => Promise<number>;
const runLauncher: Launcher = async () => 0;
const rethrow = (error: Error): never => {
  throw error;
};
