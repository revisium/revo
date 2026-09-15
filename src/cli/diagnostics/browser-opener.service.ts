import { spawn } from 'node:child_process';

import { Injectable } from '@nestjs/common';

const OPEN_TIMEOUT_MILLISECONDS = 1_000;

@Injectable()
export class BrowserOpenerService {
  open(url: string): Promise<boolean> {
    const command = commandFor(process.platform);
    if (command === undefined) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      let settled = false;
      const child = spawn(command, [url], { shell: false, stdio: 'ignore' });
      const finish = (opened: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(opened);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(false);
      }, OPEN_TIMEOUT_MILLISECONDS);
      child.once('error', () => finish(false));
      child.once('exit', (code) => finish(code === 0));
    });
  }
}

function commandFor(platform: NodeJS.Platform): 'open' | 'xdg-open' | undefined {
  if (platform === 'darwin') {
    return 'open';
  }
  if (platform === 'linux') {
    return 'xdg-open';
  }
  return undefined;
}
