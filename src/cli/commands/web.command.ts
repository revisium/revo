import { Command } from 'nest-commander';

import { WebCommandService } from '../web-command.service.js';
import { StrictCommandRunner } from './strict-command-runner.js';

@Command({ name: 'web', description: 'Start Revo if needed and print its web URL' })
export class WebCommand extends StrictCommandRunner {
  constructor(private readonly web: WebCommandService) {
    super();
  }

  async run(): Promise<void> {
    await this.web.run({});
  }
}
