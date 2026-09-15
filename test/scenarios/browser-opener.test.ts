import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BrowserOpenerService } from '../../src/cli/diagnostics/browser-opener.service.js';

describe('browser opener', () => {
  it('uses the platform executable with argv, and bounds failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-browser-'));
    const previousPath = process.env.PATH;
    const previousArgv = process.env.REVO_BROWSER_ARGV;
    const previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const argvPath = join(root, 'argv');
    const executable = join(root, 'open');
    try {
      await writeFile(
        executable,
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$REVO_BROWSER_ARGV"\n',
        'utf8',
      );
      await chmod(executable, 0o700);
      process.env.PATH = root;
      process.env.REVO_BROWSER_ARGV = argvPath;
      setPlatform('darwin');

      await expect(new BrowserOpenerService().open('https://revo.example')).resolves.toBe(true);
      await expect(readFile(argvPath, 'utf8')).resolves.toBe('https://revo.example\n');

      await writeFile(executable, '#!/bin/sh\nexit 7\n', 'utf8');
      await expect(new BrowserOpenerService().open('https://revo.example')).resolves.toBe(false);

      await writeFile(executable, '#!/bin/sh\nexec sleep 3\n', 'utf8');
      await expect(new BrowserOpenerService().open('https://revo.example')).resolves.toBe(false);

      process.env.PATH = join(root, 'missing');
      await expect(new BrowserOpenerService().open('https://revo.example')).resolves.toBe(false);

      setPlatform('win32');
      await expect(new BrowserOpenerService().open('https://revo.example')).resolves.toBe(false);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      if (previousArgv === undefined) {
        delete process.env.REVO_BROWSER_ARGV;
      } else {
        process.env.REVO_BROWSER_ARGV = previousArgv;
      }
      if (previousPlatform !== undefined) {
        Object.defineProperty(process, 'platform', previousPlatform);
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses xdg-open on Linux', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-browser-linux-'));
    const previousPath = process.env.PATH;
    const previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const executable = join(root, 'xdg-open');
    try {
      await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(executable, 0o700);
      process.env.PATH = root;
      setPlatform('linux');

      await expect(new BrowserOpenerService().open('http://127.0.0.1:3210')).resolves.toBe(true);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      if (previousPlatform !== undefined) {
        Object.defineProperty(process, 'platform', previousPlatform);
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
}
