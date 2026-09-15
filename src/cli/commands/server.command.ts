import { Command } from 'nest-commander';

import { CliUsageError } from '../cli-error.js';
import { PackageMetadataService } from '../package-metadata.service.js';
import { ServerLogsCommand } from './server-logs.command.js';
import { ServerStartCommand } from './server-start.command.js';
import { ServerStatusCommand } from './server-status.command.js';
import { ServerStopCommand } from './server-stop.command.js';
import { StrictCommandRunner } from './strict-command-runner.js';
@Command({
  name: 'server',
  description: 'Manage the Revo server',
  subCommands: [ServerStartCommand, ServerStatusCommand, ServerStopCommand, ServerLogsCommand],
})
export class ServerCommand extends StrictCommandRunner {
  constructor(private readonly metadata: PackageMetadataService) {
    super();
  }

  async run(): Promise<void> {
    await Promise.resolve();
    throw new CliUsageError(
      `Usage: ${this.metadata.cliName} server <start|status|stop|logs>\n` +
        `Run '${this.metadata.cliName} server <command> --help' for options.`,
    );
  }
}
