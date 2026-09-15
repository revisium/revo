import { SubCommand } from 'nest-commander';

import { ServerCommandService } from '../server-command.service.js';
import { StrictCommandRunner } from './strict-command-runner.js';
@SubCommand({ name: 'stop', description: 'Stop the Revo server' })
export class ServerStopCommand extends StrictCommandRunner {
  constructor(private readonly server: ServerCommandService) {
    super();
  }

  async run(): Promise<void> {
    await this.server.stop();
  }
}
