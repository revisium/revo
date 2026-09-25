import { SubCommand } from 'nest-commander';

import { CliUsageError } from '../cli-error.js';
import { PackageMetadataService } from '../package-metadata.service.js';
import { StrictCommandRunner } from './strict-command-runner.js';
import { TuiStorageMigrateCommand } from './tui-storage-migrate.command.js';

@SubCommand({
  name: 'storage',
  description: 'Manage Revo TUI command storage',
  subCommands: [TuiStorageMigrateCommand],
})
export class TuiStorageCommand extends StrictCommandRunner {
  constructor(private readonly metadata: PackageMetadataService) {
    super();
  }

  async run(): Promise<void> {
    await Promise.resolve();
    throw new CliUsageError(
      `Usage: ${this.metadata.cliName} tui [--channel <channel>] [--config <path>] [--data-dir <path>] storage migrate --api-url <url> --confirm-offline\n` +
        `Run '${this.metadata.cliName} tui storage migrate --help' for options.`,
    );
  }
}
