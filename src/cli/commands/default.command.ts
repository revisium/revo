import { Option, RootCommand } from 'nest-commander';

import { WebCommandService } from '../web-command.service.js';
import { StrictCommandRunner } from './strict-command-runner.js';

@RootCommand({ description: 'Start Revo and print its URL' })
export class DefaultCommand extends StrictCommandRunner {
  constructor(private readonly web: WebCommandService) {
    super();
  }

  async run(_passedParams: string[], flags: { readonly web?: boolean } = {}): Promise<void> {
    await this.web.run(flags);
  }

  @Option({ flags: '--web', description: 'Open the URL in the default browser' })
  webOption(): boolean {
    return true;
  }
}
