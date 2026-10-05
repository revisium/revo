import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const script = join(process.cwd(), 'scripts', 'build-release-bundle.mjs');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function outputDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'revo-release-contract-'));
  roots.push(root);
  return join(root, 'bundle');
}

describe('release bundle command contract', () => {
  it.each(['http://example.test/revo', 'https://example.test/revo/'])(
    'rejects the release URL %s before creating output',
    async (releaseUrl) => {
      const output = await outputDirectory();

      await expect(
        runBundle(['--channel', 'stable', '--release-url', releaseUrl, '--output', output]),
      ).rejects.toThrow(/--release-url must be a canonical HTTPS URL/u);
      await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('rejects alpha when the checked-out package version is not a prerelease', async () => {
    const output = await outputDirectory();

    await expect(runBundle(['--channel', 'alpha', '--output', output])).rejects.toThrow(
      /alpha releases must use prerelease versions/u,
    );
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to write into a non-empty output directory', async () => {
    const output = await outputDirectory();
    await mkdir(output, { mode: 0o700 });
    await writeFile(join(output, 'old-artifact'), 'must remain untouched\n', { mode: 0o600 });

    await expect(runBundle(['--channel', 'stable', '--output', output])).rejects.toThrow(
      /--output must be absent or empty/u,
    );
    await expect(readdir(output)).resolves.toEqual(['old-artifact']);
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
      reject(new Error(`${stderr}${stdout} (exit=${String(code ?? signal)})`));
    });
  });
}
