import { Inject, Injectable } from '@nestjs/common';

import type { ConfigurationFlags } from '../configuration/configuration.types.js';
import { BrowserOpenerService } from './diagnostics/browser-opener.service.js';
import { OutputService } from './output.service.js';
import { ServerCommandService } from './server-command.service.js';
import { serverPublicOrigin } from './server-public-origin.js';

const BROWSER_WARNING = 'Could not open a browser; open the URL above manually.';

@Injectable()
export class WebCommandService {
  constructor(
    @Inject(ServerCommandService)
    private readonly server: Pick<ServerCommandService, 'ensureRunning'>,
    @Inject(BrowserOpenerService)
    private readonly browser: Pick<BrowserOpenerService, 'open'>,
    @Inject(OutputService)
    private readonly output: Pick<OutputService, 'write' | 'writeError'>,
  ) {}

  async run(flags: { readonly web?: boolean }): Promise<void> {
    const outcome = await this.server.ensureRunning({} satisfies ConfigurationFlags);
    const url = serverPublicOrigin(outcome);
    this.output.write(url);
    if (flags.web === true && !(await this.browser.open(url))) {
      this.output.writeError(BROWSER_WARNING);
    }
  }
}
