import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { embeddedPayload } from './support/installation/installer-builder-scenario.js';
import {
  cleanupPortableToolchain,
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
const waitFor = async (path: string, deadline = Date.now() + 15000): Promise<void> => {
  try {
    await access(path);
  } catch {
    if (Date.now() >= deadline) {
      throw new Error('fixture barrier timed out');
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    return waitFor(path, deadline);
  }
};
const runVersion = (executable: string) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (output += chunk));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve(output.trim()) : reject(new Error('node probe failed')),
    );
  });

describe('generated POSIX private attempts', () => {
  it.each(['stable', 'alpha'] as const)(
    'embeds an autonomous %s production payload and private Node phase',
    async (channel) => {
      const script = await toolchainInstaller(channel);
      const payload = embeddedPayload(script);
      expect(payload).toContain('publishNodeBootstrap');
      expect(payload).toContain('revo-package-install/v1');
      expect(payload).not.toContain('src/installation');
      expect(script).toContain('revo_attempt=');
      expect(script).toContain('REVO_NODE_STAGE=$revo_stage');
      expect(script).toContain('REVO_INSTALL_MODE=node');
      expect(script).toContain('REVO_INSTALL_MODE=pnpm');
      expect(script).toContain('$revo_final/bin/node');
      expect(payload).toContain('new AbortController');
      expect(payload).toContain('controller.signal');
      expect(await syntax(script)).toBe(0);
    },
  );

  it('keeps Node archive, payload, and scratch paths separate', async () => {
    const script = await toolchainInstaller();
    expect(script).toContain('revo_stage=$revo_attempt/node');
    expect(script).toContain('revo_runtime_stage=$revo_attempt/runtime');
    expect(script).toContain('revo_scratch=$revo_runtime_stage/scratch');
    expect(script).not.toContain('mv "$revo_final/bootstrap.json"');
    expect(script).not.toContain('mv "$revo_final/payload.mjs"');
  });

  it('does not alter the v2 Node-only generated contract', async () => {
    const script = await nodeInstaller();
    expect(script).toContain('revo_lock=$revo_parent/.$revo_target.install.lock');
    expect(script).not.toContain("revo_channel='stable'");
    expect(await syntax(script)).toBe(0);
  });

  it('isolates stable and alpha attempt roots and release payloads', async () => {
    const stable = await toolchainInstaller('stable');
    const alpha = await toolchainInstaller('alpha');
    expect(stable).toContain("revo_channel='stable'");
    expect(alpha).toContain("revo_channel='alpha'");
    expect(stable).not.toBe(alpha);
    expect(embeddedPayload(stable)).toContain('"channel":"stable"');
    expect(embeddedPayload(alpha)).toContain('"channel":"alpha"');
  });

  it('retains failed attempts and cleans only after canonical completion', async () => {
    const script = await toolchainInstaller();
    expect(script).toContain('revo_attempt_cleanup=0');
    expect(script).toContain('revo_attempt_cleanup=1');
    expect(script).toContain('if [ -n "$revo_attempt" ]');
    expect(script).toContain('revo_attempt_cleanup=1\n  exit 0');
  });

  it('executes the bundled installer concurrently and reuses an offline target', async () => {
    const subject = await portableToolchain();
    const identity = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
    try {
      expect((await subject.runTogether()).sort((left, right) => left - right)).toEqual([0, 0]);
      expect(await subject.attempts()).toHaveLength(0);
      const target = join(
        subject.root,
        `state/stable/node/${process.versions.node}`,
        identity,
        'bin/node',
      );
      await access(target);
      expect(await runVersion(target)).toBe(`v${process.versions.node}`);
      expect(await readFile(subject.pnpmNodeRecord, 'utf8')).toContain(target);
      expect(
        await readdir(join(subject.root, `state/stable/node/${process.versions.node}`, identity)),
      ).not.toEqual(
        expect.arrayContaining([
          'node-archive',
          'node-version',
          'payload.mjs',
          'bootstrap.json',
          'scratch',
        ]),
      );
      const installs = (await readFile(subject.pnpmInstalls, 'utf8')).length;
      expect(await subject.startInstaller({ REVO_CURL_OFFLINE: '1' }).finish).toBe(0);
      expect(await readFile(subject.pnpmInstalls, 'utf8')).toHaveLength(installs);
      expect(await subject.attempts()).toHaveLength(0);
    } finally {
      await cleanupPortableToolchain(subject.root);
    }
  }, 30000);

  it('prepares stable and alpha releases concurrently in isolated package targets', async () => {
    const stable = await portableToolchain('stable');
    const alpha = await portableToolchain('alpha');
    try {
      expect(await Promise.all([stable.runInstaller(), alpha.runInstaller()])).toEqual([0, 0]);
      await access(join(stable.root, 'state/stable/package/1.2.3'));
      await access(join(alpha.root, 'state/alpha/package/1.2.3-alpha.1'));
      expect(stable.root).not.toBe(alpha.root);
    } finally {
      await Promise.all([
        cleanupPortableToolchain(stable.root),
        cleanupPortableToolchain(alpha.root),
      ]);
    }
  }, 40000);

  it('shares toolchain targets while separating same-channel release packages', async () => {
    const first = await portableToolchain('stable', '1.2.3');
    const second = await portableToolchain('stable', '1.2.4');
    const root = join(first.root, 'shared-state');
    try {
      expect(
        await Promise.all([
          first.startInstaller({ REVO_INSTALL_ROOT: root }).finish,
          second.startInstaller({ REVO_INSTALL_ROOT: root }).finish,
        ]),
      ).toEqual([0, 0]);
      const identity = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
      await access(join(root, 'stable/package/1.2.3'));
      await access(join(root, 'stable/package/1.2.4'));
      await access(join(root, `stable/node/${process.versions.node}`, identity));
      await access(join(root, `stable/pnpm/${process.versions.node}`, identity, '12.5.1'));
    } finally {
      await Promise.all([
        cleanupPortableToolchain(first.root),
        cleanupPortableToolchain(second.root),
      ]);
    }
  }, 40000);

  it('lets a same-channel competitor publish while a cancelled attempt is held', async () => {
    const subject = await portableToolchain();
    const hold = join(subject.root, 'download.hold');
    try {
      await writeFile(hold, 'hold');
      const cancelled = subject.startInstaller({ REVO_CURL_HOLD: hold });
      await waitFor(subject.calls);
      expect(await subject.runInstaller()).toBe(0);
      cancelled.child.kill('SIGTERM');
      await rm(hold);
      expect(await cancelled.finish).toBe(143);
      expect(await subject.attempts()).toHaveLength(1);
    } finally {
      await cleanupPortableToolchain(subject.root);
    }
  }, 30000);

  it('retains a failed package attempt, then permits a clean retry', async () => {
    const subject = await portableToolchain();
    try {
      expect(await subject.startInstaller({ REVO_PNPM_FAIL: '1' }).finish).not.toBe(0);
      expect(await subject.attempts()).toHaveLength(1);
      expect(await subject.runInstaller()).toBe(0);
      expect(await subject.attempts()).toHaveLength(1);
      expect(await readFile(join(subject.root, 'curl.calls'), 'utf8')).toHaveLength(1);
    } finally {
      await cleanupPortableToolchain(subject.root);
    }
  }, 30000);

  it.each([
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'cancels a running package child after readiness with %s',
    async (signal, code) => {
      const subject = await portableToolchain();
      const hold = join(subject.root, 'pnpm.hold');
      try {
        await writeFile(hold, 'hold');
        const running = subject.startInstaller({ REVO_PNPM_HOLD: hold });
        await waitFor(subject.pnpmStarted);
        running.child.kill(signal);
        expect(await running.finish).toBe(code);
        expect(await subject.attempts()).toHaveLength(1);
        await rm(hold);
        expect(await subject.runInstaller()).toBe(0);
        expect(await readFile(subject.calls, 'utf8')).toHaveLength(1);
      } finally {
        await cleanupPortableToolchain(subject.root);
      }
    },
    30000,
  );

  it('retains an interrupted private attempt and retries after SIGKILL', async () => {
    const subject = await portableToolchain();
    const hold = join(subject.root, 'download.hold');
    try {
      await writeFile(hold, 'hold');
      const running = subject.startInstaller({ REVO_CURL_HOLD: hold });
      await waitFor(subject.calls);
      running.child.kill('SIGKILL');
      await rm(hold);
      await running.finish;
      expect(await subject.attempts()).toHaveLength(1);
      expect(await subject.runInstaller()).toBe(0);
      expect(await subject.attempts()).toHaveLength(1);
    } finally {
      await cleanupPortableToolchain(subject.root);
    }
  }, 30000);

  it('fails closed on a legacy v3 lock without touching the channel', async () => {
    const subject = await portableToolchain();
    try {
      await mkdir(join(subject.root, 'state/stable/.install.lock'), {
        recursive: true,
        mode: 0o700,
      });
      expect(await subject.runInstaller()).not.toBe(0);
      expect(await subject.attempts()).toHaveLength(0);
    } finally {
      await cleanupPortableToolchain(subject.root);
    }
  });
});
