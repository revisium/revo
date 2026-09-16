import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { readActivation } from '../src/installation/activation-store.js';
import {
  cleanupPortableToolchain,
  installerData,
  nodeData,
  nodeInstaller,
  portableToolchain,
  toolchainInstaller,
} from './support/installation/installer-toolchain-scenario.js';

const syntax = (script: string) =>
  new Promise<number>((resolve) => {
    const child = spawn('/bin/sh', ['-n'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(script);
    child.once('close', (code) => resolve(code ?? 1));
  });

it('real activation mode packs the compiled helper', async () => {
  const subject = await portableToolchain('stable', undefined, false, true);
  let failed = false;
  try {
    expect(subject.plan.release.version).toBe('0.0.0');
    const exit = await subject.startInstaller().finish;
    failed = exit !== 0;
    expect(exit).toBe(0);
    const current = await readActivation(join(subject.root, 'state', 'stable'));
    expect(current.status).toBe('valid');
    if (current.status === 'valid') {
      expect(current.record.release.version).toBe(subject.plan.release.version);
      expect(current.record.toolchain.nodeArchiveSha256).toBe(subject.nodeArchiveSha256);
      expect(current.record.toolchain.pnpmArchiveSha256).toBe(subject.pnpmArchiveSha256);
      expect(current.record.launcherProtocol).toBe('revo-activation-launcher/v2');
      const generation = current.record.generationId;
      expect(await subject.startInstaller().finish).toBe(0);
      const retry = await readActivation(join(subject.root, 'state', 'stable'));
      expect(retry.status).toBe('valid');
      if (retry.status === 'valid') expect(retry.record.generationId).toBe(generation);
    }
  } finally {
    if (!failed) await cleanupPortableToolchain(subject.root);
    else console.error(`REAL_FAILURE_ROOT=${subject.root}`);
  }
}, 180_000);

describe('generated POSIX toolchain installer', () => {
  it.each(['stable', 'alpha'] as const)(
    'embeds isolated %s Node and pnpm handoff',
    async (channel) => {
      const script = await toolchainInstaller(channel);
      const data = await installerData(channel);
      expect(data.channel).toBe(channel);
      expect(script).toContain('revo_lock=$revo_channel_root/.install.lock');
      expect(script).toContain('REVO_INSTALL_MODE=pnpm');
      expect(script).toContain('REVO_INSTALL_SCRATCH=$revo_scratch');
      expect(await syntax(script)).toBe(0);
    },
  );
  it('retains the v2 Node-only lock and payload contract', async () => {
    const script = await nodeInstaller();
    expect(script).toContain('revo_parent=$revo_root/$revo_version');
    expect(script).toContain('revo_lock=$revo_parent/.$revo_target.install.lock');
    expect((await nodeData()).channel).toBeUndefined();
  });
  it('keeps literal bootstrap and payload delimiters singular', async () => {
    const script = await toolchainInstaller();
    expect(script.match(/^REVO_NODE_BOOTSTRAP_DATA$/gmu)).toHaveLength(1);
    expect(script.match(/^REVO_NODE_BOOTSTRAP_PAYLOAD$/gmu)).toHaveLength(1);
    expect(script).toContain("revo_channel='stable'");
  });
  it('publishes Node from a private attempt before the canonical re-exec', async () => {
    const script = await toolchainInstaller();
    expect(script).toContain('revo_attempt=');
    expect(script).toContain('REVO_INSTALL_MODE=node');
    expect(script).toContain('$revo_final/bin/node');
    expect(script).not.toContain('mv "$revo_final/bootstrap.json"');
  });
  it.each(['stable', 'alpha'] as const)(
    'runs generated %s bytes fresh and reuses Node',
    async (channel) => {
      const subject = await portableToolchain(channel);
      try {
        expect(await subject.runInstaller()).toBe(0);
        expect(await subject.runInstaller()).toBe(0);
        const identity = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
        const target = join(
          subject.root,
          'state',
          channel,
          'node',
          process.versions.node,
          identity,
        );
        const pnpm = join(
          subject.root,
          'state',
          channel,
          'pnpm',
          process.versions.node,
          identity,
          '12.4.1',
        );
        expect(await readFile(join(target, 'install-receipt.json'), 'utf8')).toContain(identity);
        expect(await readFile(join(pnpm, 'install-receipt.json'), 'utf8')).toContain('12.4.1');
        expect(await readFile(subject.calls, 'utf8')).toHaveLength(1);
        await writeFile(join(target, 'install-receipt.json'), '{}\n');
        expect(await subject.runInstaller()).not.toBe(0);
      } finally {
        await cleanupPortableToolchain(subject.root);
      }
    },
    30000,
  );
  it('drains an interrupted generated download and preserves the signal status', async () => {
    const subject = await portableToolchain();
    const hold = join(subject.root, 'hold');
    try {
      await writeFile(hold, 'hold');
      const running = subject.startInstaller({ REVO_CURL_HOLD: hold });
      await vi.waitFor(
        async () => {
          expect(await readFile(subject.calls, 'utf8')).toHaveLength(1);
        },
        { timeout: 5000, interval: 10 },
      );
      running.child.kill('SIGINT');
      expect(await running.finish).toBe(130);
    } finally {
      await cleanupPortableToolchain(subject.root);
    }
  }, 15000);
});
