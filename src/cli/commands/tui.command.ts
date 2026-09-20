import { Command, Option } from 'nest-commander';

import type { ConfigurationFlags } from '../../configuration/configuration.types.js';
import { TuiCommandService } from '../tui-command.service.js';
import { StrictCommandRunner } from './strict-command-runner.js';

@Command({ name: 'tui', description: 'Start Revo and open its terminal interface' })
export class TuiCommand extends StrictCommandRunner {
  constructor(private readonly tui: TuiCommandService) {
    super();
  }

  async run(_passedParams: string[], flags: ConfigurationFlags = {}): Promise<void> {
    await this.tui.run(flags);
  }

  @Option({ flags: '--channel <channel>', description: 'Release channel to start' })
  channel(value: string): string {
    return value;
  }

  @Option({ flags: '--config <path>', description: 'Configuration file path' })
  config(value: string): string {
    return value;
  }

  @Option({ flags: '--data-dir <path>', description: 'Product data directory' })
  dataDir(value: string): string {
    return value;
  }

  @Option({ flags: '--startup-timeout <milliseconds>', description: 'Startup budget' })
  startupTimeout(value: string): string {
    return value;
  }
}
