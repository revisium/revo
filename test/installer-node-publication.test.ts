import { execFile } from 'node:child_process';
// oxlint-disable no-explicit-any, no-unsafe-type-assertion -- compact installer scenario
import {
  chmod,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  embeddedBootstrap,
  pnpmInstallerBuilderScenario,
} from './support/installation/installer-builder-scenario.js';
import { pnpmBootstrapScenario } from './support/installation/pnpm-bootstrap-scenario.js';

type Data = Record<string, any>;
type Api = {
  publishNodeBootstrap: (input: Data) => Promise<Data>;
  runBootstrap: (input: Data) => Promise<Data>;
};
const api = await vi.importActual<Api>(
  new URL('../installer/node-bootstrap.mjs', import.meta.url).href,
);
const engine = new URL('../installer/node-bootstrap.mjs', import.meta.url).pathname;
const execute = promisify(execFile);
const nodePlatform = process.platform;
const nodeArch = process.arch;
const PUBLISHER_CHILD_TIMEOUT_MS = 15_000;
const { buildInstaller } = await vi.importActual<{ buildInstaller: (input: unknown) => string }>(
  new URL('../installer/build-installer.mjs', import.meta.url).href,
);

const fixture = async () => {
  const value = embeddedBootstrap(
    buildInstaller(
      pnpmInstallerBuilderScenario({
        core: '4.3.2',
        admin: '5.4.3',
        node: process.versions.node,
        pnpm: '12.5.1',
      }),
    ),
  ) as Data;
  const scenario = await pnpmBootstrapScenario(engine, value);
  const cleanup = () => rm(scenario.root, { recursive: true, force: true });
  try {
    const channelRoot = join(scenario.root, 'channel');
    await mkdir(channelRoot);
    const node = await scenario.prepareNodeStage();
    const archiveSha256 = value.archives.find(
      (item: Data) => item.platform === nodePlatform && item.arch === nodeArch,
    ).sha256;
    await api.runBootstrap({
      dataPath: scenario.dataPath,
      receiptPath: join(node.stage, 'install-receipt.json'),
      target: `${nodePlatform}-${nodeArch}`,
      archiveSha256,
    });
    return { value, scenario, channelRoot, node, archiveSha256, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
};
const input = (data: Data, stage = data.node.stage) => ({
  bootstrap: data.value,
  stage,
  channelRoot: data.channelRoot,
  platform: nodePlatform,
  arch: nodeArch,
  signal: undefined,
  policy: { probeTimeoutMs: 5_000 },
});
const target = (root: string) =>
  join(root, 'channel', 'node', process.versions.node, `${nodePlatform}-${nodeArch}`);
const executable = (root: string) => join(target(root), 'bin', 'node');

describe('managed Node bootstrap publication', () => {
  it('publishes a verified staged Node with its exact receipt', async () => {
    const data = await fixture();
    const receipt = await readFile(join(data.node.stage, 'install-receipt.json'), 'utf8');
    try {
      const result = await api.publishNodeBootstrap(input(data));
      expect(result).toEqual({
        directory: target(data.scenario.root),
        executablePath: executable(data.scenario.root),
        reused: false,
      });
      expect(await readFile(join(target(data.scenario.root), 'install-receipt.json'), 'utf8')).toBe(
        receipt,
      );
      expect(
        (await stat(join(target(data.scenario.root), 'install-receipt.json'))).mode & 0o777,
      ).toBe(0o600);
      expect((await execute(executable(data.scenario.root), ['--version'])).stdout.trim()).toBe(
        `v${process.versions.node}`,
      );
      expect(await readFile(join(target(data.scenario.root), 'include', 'node.h'), 'utf8')).toBe(
        'native node header\n',
      );
      expect(await readlink(join(target(data.scenario.root), 'bin', 'npm'))).toBe(
        '../lib/node_modules/npm/bin/npm-cli.js',
      );
    } finally {
      await data.cleanup();
    }
  });

  it('reuses a compatible Node target and leaves a fresh stage intact', async () => {
    const data = await fixture();
    try {
      await api.publishNodeBootstrap(input(data));
      const second = await data.scenario.prepareNodeStage();
      await api.runBootstrap({
        dataPath: data.scenario.dataPath,
        receiptPath: join(second.stage, 'install-receipt.json'),
        target: `${nodePlatform}-${nodeArch}`,
        archiveSha256: data.archiveSha256,
      });
      const result = await api.publishNodeBootstrap(input(data, second.stage));
      expect(result.reused).toBe(true);
      expect(result.executablePath).toBe(executable(data.scenario.root));
      expect(await stat(second.stage)).toBeTruthy();
    } finally {
      await data.cleanup();
    }
  });

  it('accepts a private stage inside the channel and keeps the archive tree', async () => {
    const data = await fixture();
    const inner = await data.scenario.prepareNodeStage('inner', true);
    await api.runBootstrap({
      dataPath: data.scenario.dataPath,
      receiptPath: join(inner.stage, 'install-receipt.json'),
      target: `${nodePlatform}-${nodeArch}`,
      archiveSha256: data.archiveSha256,
    });
    try {
      const result = await api.publishNodeBootstrap(input(data, inner.stage));
      expect(result.executablePath).toBe(executable(data.scenario.root));
      expect(await stat(join(target(data.scenario.root), 'share', 'doc', 'README'))).toBeTruthy();
    } finally {
      await data.cleanup();
    }
  });

  it('rejects a reused target whose canonical Node reports a bare version', async () => {
    const data = await fixture();
    const second = await data.scenario.prepareNodeStage('bad-runtime');
    await api.runBootstrap({
      dataPath: data.scenario.dataPath,
      receiptPath: join(second.stage, 'install-receipt.json'),
      target: `${nodePlatform}-${nodeArch}`,
      archiveSha256: data.archiveSha256,
    });
    try {
      await api.publishNodeBootstrap(input(data));
      await writeFile(
        executable(data.scenario.root),
        `#!/bin/sh\nprintf '%s\\n' '${process.versions.node}'\n`,
      );
      await chmod(executable(data.scenario.root), 0o755);
      await expect(api.publishNodeBootstrap(input(data, second.stage))).rejects.toThrow(
        /version|probe/iu,
      );
    } finally {
      await data.cleanup();
    }
  });

  it('keeps a staged Node when publication is cancelled before rename', async () => {
    const data = await fixture();
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        api.publishNodeBootstrap({ ...input(data), signal: controller.signal }),
      ).rejects.toThrow(/cancel/iu);
      expect(await stat(data.node.stage)).toBeTruthy();
      expect(await readdir(data.channelRoot)).toEqual([]);
    } finally {
      await data.cleanup();
    }
  });

  it('rejects an incompatible target without touching it or the stage', async () => {
    const data = await fixture();
    const targetPath = target(data.scenario.root);
    try {
      await mkdir(targetPath, { recursive: true });
      await writeFile(join(targetPath, 'install-receipt.json'), '{}\n', { mode: 0o600 });
      await expect(api.publishNodeBootstrap(input(data))).rejects.toThrow(
        /incompatible|receipt|unsafe/iu,
      );
      expect(await stat(data.node.stage)).toBeTruthy();
      expect(await readFile(join(targetPath, 'install-receipt.json'), 'utf8')).toBe('{}\n');
    } finally {
      await data.cleanup();
    }
  });

  it('rejects symlink targets and stages inside the channel root', async () => {
    const data = await fixture();
    const targetPath = target(data.scenario.root);
    const referent = join(data.scenario.root, 'foreign-node');
    try {
      await mkdir(referent);
      await mkdir(join(data.channelRoot, 'node', process.versions.node), { recursive: true });
      await symlink(referent, targetPath);
      await expect(api.publishNodeBootstrap(input(data))).rejects.toThrow(/unsafe/iu);
      await rm(targetPath);
      await expect(
        api.publishNodeBootstrap(input(data, join(data.channelRoot, 'staged'))),
      ).rejects.toThrow(/outside|boundary/iu);
      expect(await stat(data.node.stage)).toBeTruthy();
    } finally {
      await data.cleanup();
    }
  });

  it('keeps the stage for EXDEV and other publication failures', async () => {
    const data = await fixture();
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...fs,
      rename: async () => {
        throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
      },
    }));
    try {
      vi.resetModules();
      const prepared = await vi.importActual<Api>(
        new URL('../installer/node-bootstrap.mjs', import.meta.url).href,
      );
      await expect(prepared.publishNodeBootstrap(input(data))).rejects.toThrow(
        /cross|filesystems/iu,
      );
      expect(await stat(data.node.stage)).toBeTruthy();
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
      await data.cleanup();
    }
  });

  it('preserves a late incompatible winner and the losing stage', async () => {
    const data = await fixture();
    const competitor = await data.scenario.prepareNodeStage('competitor');
    await writeFile(join(competitor.stage, 'install-receipt.json'), '{}\n', { mode: 0o600 });
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let raced = false;
    vi.doMock('node:fs/promises', () => ({
      ...fs,
      rename: async (from: string, to: string) => {
        if (!raced && to === target(data.scenario.root)) {
          raced = true;
          await fs.rename(competitor.stage, to);
          throw Object.assign(new Error('collision'), { code: 'EEXIST' });
        }
        return fs.rename(from, to);
      },
    }));
    try {
      vi.resetModules();
      const prepared = await vi.importActual<Api>(
        new URL('../installer/node-bootstrap.mjs', import.meta.url).href,
      );
      await expect(prepared.publishNodeBootstrap(input(data))).rejects.toThrow(
        /incompatible|receipt/iu,
      );
      expect(await stat(data.node.stage)).toBeTruthy();
      expect(await readFile(join(target(data.scenario.root), 'install-receipt.json'), 'utf8')).toBe(
        '{}\n',
      );
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
      await data.cleanup();
    }
  });

  it('converges two real publisher processes on one compatible Node target', async () => {
    const data = await fixture();
    const attempts = await Promise.all([
      data.scenario.prepareNodeStage('process-a'),
      data.scenario.prepareNodeStage('process-b'),
    ]);
    await Promise.all(
      attempts.map((attempt) =>
        api.runBootstrap({
          dataPath: data.scenario.dataPath,
          receiptPath: join(attempt.stage, 'install-receipt.json'),
          target: `${nodePlatform}-${nodeArch}`,
          archiveSha256: data.archiveSha256,
        }),
      ),
    );
    try {
      const outcomes = await data.scenario.publishNodeTogether(attempts, input(data));
      expect(outcomes.every(({ ok }) => ok)).toBe(true);
      expect(
        outcomes
          .map(({ result }) => (result as Data | undefined)?.reused)
          .sort((a, b) => Number(a) - Number(b)),
      ).toEqual([false, true]);
      expect(await stat(target(data.scenario.root))).toBeTruthy();
      const retained = await Promise.all(
        attempts.map(({ stage }) =>
          stat(stage)
            .then(() => true)
            .catch(() => false),
        ),
      );
      expect(retained).toContain(true);
    } finally {
      await data.cleanup();
    }
  }, 60_000);

  it('fails fast and cleans publisher children that exit before ready', async () => {
    const data = await fixture();
    const attempts = await Promise.all([
      data.scenario.prepareNodeStage('process-a'),
      data.scenario.prepareNodeStage('process-b'),
    ]);
    const started = Date.now();
    try {
      await expect(
        data.scenario.publishNodeTogether(attempts, {
          ...input(data),
          testPublisherMode: 'exit-before-ready',
        }),
      ).rejects.toThrow(/exited before ready/iu);
      expect(Date.now() - started).toBeLessThan(PUBLISHER_CHILD_TIMEOUT_MS);
    } finally {
      await data.cleanup();
    }
  }, 30_000);
});
