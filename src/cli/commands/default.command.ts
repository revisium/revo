import { Option, RootCommand } from 'nest-commander';

import { TuiCommandService } from '../tui-command.service.js';
import { WebCommandService } from '../web-command.service.js';
import { StrictCommandRunner } from './strict-command-runner.js';

@RootCommand({
  description: 'Start Revo and open its terminal interface (prints the URL without a terminal)',
})
export class DefaultCommand extends StrictCommandRunner {
  constructor(
    private readonly web: WebCommandService,
    private readonly tui: TuiCommandService,
  ) {
    super();
  }

  async run(_passedParams: string[], flags: { readonly web?: boolean } = {}): Promise<void> {
    if (flags.web !== true && this.tui.interactive()) {
      await this.tui.run({});
      return;
    }
    await this.web.run(flags);
  }

  @Option({ flags: '--web', description: 'Open the URL in the default browser' })
  webOption(): boolean {
    return true;
  }
}
