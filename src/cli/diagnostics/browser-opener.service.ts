import { spawn } from 'node:child_process';

import { Injectable } from '@nestjs/common';

const OPEN_TIMEOUT_MILLISECONDS = 5_000;

@Injectable()
export class BrowserOpenerService {
  open(url: string): Promise<boolean> {
    const command =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'linux'
          ? 'xdg-open'
          : undefined;
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
