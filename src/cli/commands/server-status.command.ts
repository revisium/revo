import { SubCommand } from 'nest-commander';

import { ServerCommandService } from '../server-command.service.js';
import { StrictCommandRunner } from './strict-command-runner.js';
@SubCommand({ name: 'status', description: 'Report the Revo server status' })
export class ServerStatusCommand extends StrictCommandRunner {
  constructor(private readonly server: ServerCommandService) {
    super();
  }

  async run(): Promise<void> {
    await this.server.status();
  }
}
