import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const script = join(process.cwd(), 'scripts', 'build-release-bundle.mjs');

describe('release bundle command contract', () => {
  it('rejects a non-HTTPS origin before creating output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-release-contract-'));
    const output = join(root, 'bundle');
    try {
      await expect(
        runBundle([
          '--channel',
          'stable',
          '--origin',
          'http://example.test/revo',
          '--output',
          output,
        ]),
      ).rejects.toThrow(/HTTPS/iu);
      await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects alpha when the checked-out package is stable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-release-contract-'));
    const output = join(root, 'bundle');
    try {
      await expect(
        runBundle([
          '--channel',
          'alpha',
          '--origin',
          'https://example.test/revo',
          '--output',
          output,
        ]),
      ).rejects.toThrow(/alpha|prerelease|version/iu);
      await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to write into a non-empty output directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-release-contract-'));
    const output = join(root, 'bundle');
    try {
      await mkdir(output, { mode: 0o700 });
      await writeFile(join(output, 'old-artifact'), 'must remain untouched\n', { mode: 0o600 });
      await expect(
        runBundle([
          '--channel',
          'stable',
          '--origin',
          'https://example.test/revo',
          '--output',
          output,
        ]),
      ).rejects.toThrow(/absent or empty/iu);
      await expect(readdir(output)).resolves.toEqual(['old-artifact']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function runBundle(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${stderr}${stdout} (exit=${code ?? signal ?? 'unknown'})`));
    });
  });
}
