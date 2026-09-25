import { Command, Option } from 'nest-commander';

import type { ConfigurationFlags } from '../../configuration/configuration.types.js';
import { CliUsageError } from '../cli-error.js';
import { TuiCommandService } from '../tui-command.service.js';
import { StrictCommandRunner } from './strict-command-runner.js';
import { TuiStorageCommand } from './tui-storage.command.js';

@Command({
  name: 'tui',
  description: 'Start Revo and open its terminal interface',
  subCommands: [TuiStorageCommand],
})
export class TuiCommand extends StrictCommandRunner {
  constructor(private readonly tui: TuiCommandService) {
    super();
  }

  async run(_passedParams: string[], flags: ConfigurationFlags = {}): Promise<void> {
    await this.tui.run(flags);
  }

  @Option({ flags: '--channel <channel>', description: 'Release channel to start' })
  channel(value: string, previous?: string): string {
    assertNotRepeated(previous, '--channel');
    return value;
  }

  @Option({ flags: '--config <path>', description: 'Configuration file path' })
  config(value: string, previous?: string): string {
    assertNotRepeated(previous, '--config');
    return value;
  }

  @Option({ flags: '--data-dir <path>', description: 'Product data directory' })
  dataDir(value: string, previous?: string): string {
    assertNotRepeated(previous, '--data-dir');
    return value;
  }

  @Option({ flags: '--startup-timeout <milliseconds>', description: 'Startup budget' })
  startupTimeout(value: string): string {
    return value;
  }
}

function assertNotRepeated(previous: string | undefined, option: string): void {
  if (previous !== undefined) {
    throw new CliUsageError(`${option} may be specified only once.`);
  }
}
