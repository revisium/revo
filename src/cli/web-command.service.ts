import { Inject, Injectable } from '@nestjs/common';

import type { ConfigurationFlags } from '../configuration/configuration.types.js';
import type { ServerLaunchResult } from '../server/server-launcher.service.js';
import { BrowserOpenerService } from './diagnostics/browser-opener.service.js';
import { OutputService } from './output.service.js';
import { ServerCommandService } from './server-command.service.js';

const URL_UNAVAILABLE = 'Server is running, but its public URL is unavailable.';
const INVALID_URL = 'Server public URL is invalid.';
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
    const url = this.url(outcome);
    this.output.write(url);
    if (flags.web === true && !(await this.browser.open(url))) {
      this.output.writeError(BROWSER_WARNING);
    }
  }

  private url(outcome: ServerLaunchResult): string {
    if (outcome.kind === 'started') {
      return validOrigin(outcome.url);
    }
    if (outcome.kind === 'running') {
      if (outcome.status.publicUrl === undefined) {
        throw new Error(URL_UNAVAILABLE);
      }
      return validOrigin(outcome.status.publicUrl);
    }
    if (outcome.kind === 'stopped') {
      throw new Error('Server did not start.');
    }
    if (outcome.kind === 'unknown' || outcome.kind === 'missing') {
      throw new Error('Server status is unavailable; start was not performed.');
    }
    throw new Error(`Server is ${outcome.kind}; start was not performed.`);
  }
}

function validOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      (url.pathname !== '' && url.pathname !== '/')
    ) {
      throw new Error('invalid origin');
    }
    return url.origin;
  } catch {
    throw new Error(INVALID_URL);
  }
}
