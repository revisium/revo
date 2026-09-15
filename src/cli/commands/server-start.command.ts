import { Option, SubCommand } from 'nest-commander';

import { ServerCommandService } from '../server-command.service.js';
import { StrictCommandRunner } from './strict-command-runner.js';
@SubCommand({ name: 'start', description: 'Start the Revo server' })
export class ServerStartCommand extends StrictCommandRunner {
  constructor(private readonly server: ServerCommandService) {
    super();
  }

  async run(_passedParams: string[], flags: Record<string, string> = {}): Promise<void> {
    await this.server.start(flags);
  }

  @Option({ flags: '--channel <channel>', description: 'Release channel to start' })
  channel(value: string): string {
    return value;
  }

  @Option({ flags: '--config <path>', description: 'Configuration file path' })
  config(value: string): string {
    return value;
  }

  @Option({ flags: '--database-url <url>', description: 'External PostgreSQL connection URL' })
  databaseUrl(value: string): string {
    return value;
  }

  @Option({ flags: '--data-dir <path>', description: 'Product data directory' })
  dataDir(value: string): string {
    return value;
  }

  @Option({ flags: '--host <host>', description: 'Listener host' })
  host(value: string): string {
    return value;
  }

  @Option({ flags: '--log-dir <path>', description: 'Log directory' })
  logDir(value: string): string {
    return value;
  }

  @Option({ flags: '--port <port>', description: 'Listener port' })
  port(value: string): string {
    return value;
  }

  @Option({ flags: '--public-url <url>', description: 'Public origin advertised by the server' })
  publicUrl(value: string): string {
    return value;
  }

  @Option({ flags: '--startup-timeout <milliseconds>', description: 'Startup budget' })
  startupTimeout(value: string): string {
    return value;
  }
}
