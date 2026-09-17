import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  activateInstall,
  readActivationRequest,
  runActivationHelper,
} from '../../src/bin/revo-install-activate.js';

const requestPath = (root: string) =>
  join(root, '.attempt.test', 'runtime', 'scratch', '.activation-request-test', 'request.json');

const makeRequest = async (value: string | ((root: string) => string), mode = 0o600) => {
  const channelRoot = await mkdtemp(join('/tmp', 'revo-helper-channel-'));
  const path = requestPath(channelRoot);
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, typeof value === 'function' ? value(channelRoot) : value, { mode });
  return { channelRoot, path };
};

describe('activation helper boundary', () => {
  it('reads a valid private request and rejects unsafe boundaries', async () => {
    const { channelRoot, path } = await makeRequest((root) =>
      JSON.stringify({ schemaVersion: 'revo-install-activate/v1', channelRoot: root }),
    );
    try {
      await expect(readActivationRequest(path, channelRoot)).resolves.toMatchObject({
        channelRoot,
      });
      await expect(
        readActivationRequest(join(channelRoot, 'request.json'), channelRoot),
      ).rejects.toThrow(/activation request/u);
      await expect(readActivationRequest(path, join(channelRoot, 'other'))).rejects.toThrow(
        /activation request|ENOENT/u,
      );
    } finally {
      await rm(channelRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['activated', { status: 'activated', generationId: 'a'.repeat(64) }, 0],
    ['unchanged', { status: 'unchanged', generationId: 'b'.repeat(64) }, 0],
    ['busy', { status: 'busy' }, 1],
    ['invalid', { status: 'activated', generationId: 'bad' }, 1],
  ] as const)('returns a bounded result for %s', async (_name, outcome, expected) => {
    const { channelRoot, path } = await makeRequest((root) =>
      JSON.stringify({
        schemaVersion: 'revo-install-activate/v1',
        channelRoot: root,
        nodeArchiveSha256: 'a'.repeat(64),
        packagePlan: {},
        pnpmArchiveSha256: 'b'.repeat(64),
      }),
    );
    try {
      const result = await runActivationHelper(path, channelRoot, async () => outcome);
      expect(result).toBe(expected);
    } finally {
      await rm(channelRoot, { recursive: true, force: true });
    }
  });

  it('rejects a request leaf symlink without following it', async () => {
    const { channelRoot, path } = await makeRequest((root) =>
      JSON.stringify({ schemaVersion: 'revo-install-activate/v1', channelRoot: root }),
    );
    const target = `${path}.target`;
    try {
      await writeFile(target, await readFile(path), { mode: 0o600 });
      await rm(path);
      await symlink(target, path);
      await expect(readActivationRequest(path, channelRoot)).rejects.toThrow(
        /activation request|ELOOP/u,
      );
    } finally {
      await rm(channelRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['malformed JSON', '{'],
    ['wrong schema', JSON.stringify({ schemaVersion: 'wrong' })],
  ])('rejects %s before activation', async (_name, contents) => {
    const { channelRoot, path } = await makeRequest(contents);
    try {
      await expect(readActivationRequest(path, channelRoot)).rejects.toThrow(/activation|JSON/u);
      await expect(activateInstall({})).rejects.toThrow(/activation request is invalid/u);
    } finally {
      await rm(channelRoot, { recursive: true, force: true });
    }
  });

  it('rejects a non-private request before parsing', async () => {
    const { channelRoot, path } = await makeRequest(
      (root) => JSON.stringify({ schemaVersion: 'revo-install-activate/v1', channelRoot: root }),
      0o644,
    );
    try {
      await expect(readActivationRequest(path, channelRoot)).rejects.toThrow(/unsafe/u);
    } finally {
      await rm(channelRoot, { recursive: true, force: true });
    }
  });
});
