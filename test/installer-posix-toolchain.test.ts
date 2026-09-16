import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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
      await new Promise((resolve) => setTimeout(resolve, 100));
      running.child.kill('SIGINT');
      expect(await running.finish).toBe(130);
    } finally {
      await cleanupPortableToolchain(subject.root);
    }
  }, 15000);
});
