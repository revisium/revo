import { Option, SubCommand } from 'nest-commander';

import { ServerLogsCommandService, type ServerLogsFlags } from '../server-logs-command.service.js';
import { StrictCommandRunner } from './strict-command-runner.js';

@SubCommand({ name: 'logs', description: 'Show the Revo server lifecycle logs' })
export class ServerLogsCommand extends StrictCommandRunner {
  constructor(private readonly serverLogs: ServerLogsCommandService) {
    super();
  }

  async run(_passedParams: string[], flags: ServerLogsFlags = {}): Promise<void> {
    await this.serverLogs.logs(flags);
  }

  @Option({ flags: '--channel <channel>', description: 'Release channel to inspect' })
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

  @Option({ flags: '--follow', description: 'Follow new lifecycle events' })
  follow(): boolean {
    return true;
  }

  @Option({ flags: '--log-dir <path>', description: 'Log directory' })
  logDir(value: string): string {
    return value;
  }
}
