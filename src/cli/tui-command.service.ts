import { join } from 'node:path';
import process from 'node:process';

import { Inject, Injectable } from '@nestjs/common';
import { runRevoTui, type RunRevoTuiOptions } from '@revisium/revo-tui/launcher';

import type { ConfigurationFlags } from '../configuration/configuration.types.js';
import { CliExitCodeError } from './cli-error.js';
import { ServerCommandService } from './server-command.service.js';
import { serverPublicOrigin } from './server-public-origin.js';

export const TUI_LAUNCHER = Symbol('TUI_LAUNCHER');
export const TUI_TERMINAL = Symbol('TUI_TERMINAL');

export interface TuiTerminal {
  readonly stdin: boolean;
  readonly stdout: boolean;
}

type TuiLauncher = (options: RunRevoTuiOptions) => Promise<number>;
type TuiTerminalReader = () => Readonly<TuiTerminal>;

@Injectable()
export class TuiCommandService {
  constructor(
    @Inject(ServerCommandService)
    private readonly server: Pick<ServerCommandService, 'ensureRunningWithConfiguration'>,
    @Inject(TUI_LAUNCHER)
    private readonly launchTui: TuiLauncher,
    @Inject(TUI_TERMINAL)
    private readonly terminal: TuiTerminalReader,
  ) {}

  async run(flags: Readonly<ConfigurationFlags>): Promise<void> {
    const terminal = this.terminal();
    if (!terminal.stdin || !terminal.stdout) {
      throw new Error('revo tui requires a TTY on stdin and stdout.');
    }

    const { configuration, outcome } = await this.server.ensureRunningWithConfiguration(flags);
    const origin = serverPublicOrigin(outcome);
    const exitCode = await this.launchTui({
      apiUrl: new URL('/graphql', origin).href,
      dataDir: join(configuration.layout.dataDir, 'tui'),
    });
    if (exitCode !== 0) {
      throw new CliExitCodeError(exitCode);
    }
  }
}

export const readTuiTerminal: TuiTerminalReader = () => ({
  stdin: process.stdin.isTTY ?? false,
  stdout: process.stdout.isTTY ?? false,
});

export const launchRevoTui: TuiLauncher = (options) => runRevoTui(options);
