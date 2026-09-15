import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packageArtifactScenario } from './package-artifact-scenario.js';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function packageInstallScenario() {
  const data = await packageArtifactScenario();
  const root = await mkdtemp(join(tmpdir(), 'revo-package-install-'));
  const node = process.execPath;
  const pnpm = join(root, 'pnpm');
  await writeFile(
    pnpm,
    `#!/usr/bin/env node
const fs = await import('node:fs/promises');
await fs.writeFile(
  process.env.REVO_CAPTURE,
  JSON.stringify({ argv: process.argv.slice(2), env: process.env }),
);
console.log('install output');
console.error('install diagnostic');
if (process.env.REVO_BURST) console.log('x'.repeat(10000));
if (process.env.REVO_SIGNAL) process.kill(process.pid, process.env.REVO_SIGNAL);
if (process.env.REVO_RESIST) process.on('SIGTERM', () => {});
if (process.env.REVO_HANG) setTimeout(() => {}, 60000);
if (process.env.REVO_EXIT) process.exit(Number(process.env.REVO_EXIT));
`,
    { mode: 0o700 },
  );
  await chmod(pnpm, 0o700);
  const capture = join(root, 'capture.json');
  process.env.REVO_CAPTURE = capture;
  const request = async (url: string, init?: { readonly signal: AbortSignal }) => {
    const response = await data.request(url, init);
    return response;
  };
  const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
  return {
    ...data,
    root,
    node,
    pnpm,
    capture,
    request,
    readCapture: async () => {
      const parsed: unknown = JSON.parse(await readFile(capture, 'utf8'));
      if (!record(parsed)) {
        throw new Error('capture is invalid');
      }
      if (
        !Array.isArray(parsed.argv) ||
        !parsed.argv.every((item): item is string => typeof item === 'string') ||
        !record(parsed.env)
      ) {
        throw new Error('capture is invalid');
      }
      const env: Record<string, string> = {};
      for (const [key, item] of Object.entries(parsed.env)) {
        if (typeof item !== 'string') {
          throw new Error('capture is invalid');
        }
        env[key] = item;
      }
      return { argv: parsed.argv, env };
    },
    mode: async (path: string) => (await stat(path)).mode & 0o777,
    hash,
    cleanup: async () => {
      delete process.env.REVO_CAPTURE;
      await rm(root, { recursive: true, force: true });
      await data.cleanup();
    },
  };
}
