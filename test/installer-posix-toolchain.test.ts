import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { readActivation, type ActivationReadResult } from '../src/installation/activation-store.js';
import {
  cleanupPortableToolchain,
  installerData,
  nodeData,
  nodeInstaller,
  portableToolchain,
  toolchainInstaller,
} from './support/installation/installer-toolchain-scenario.js';
import { ServerOwnerScenario } from './support/server/server-owner-scenario.js';

const syntax = (script: string) =>
  new Promise<number>((resolve) => {
    const child = spawn('/bin/sh', ['-n'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(script);
    child.once('close', (code) => resolve(code ?? 1));
  });

const validActivation = (value: ActivationReadResult) => {
  expect(value.status).toBe('valid');
  if (value.status !== 'valid') {
    throw new Error('activation was not valid');
  }
  return value;
};

it.each(['stable', 'alpha'] as const)(
  'real %s activation mode packs the compiled helper',
  async (channel) => {
    const subject = await portableToolchain(
      channel,
      channel === 'alpha' ? '0.0.1-alpha.1' : undefined,
      false,
      true,
    );
    try {
      expect(subject.plan.release.version).toMatch(/^0\.0\./u);
      expect(await subject.startInstaller().finish).toBe(0);
      const downloads = await readFile(subject.calls, 'utf8');
      const artifactRequests = await readFile(subject.fetchCalls, 'utf8');
      const pnpmInvocations = await readFile(subject.pnpmCalls, 'utf8');
      expect(pnpmInvocations.trim().length).toBeGreaterThan(0);
      const current = validActivation(await readActivation(join(subject.root, 'state', channel)));
      expect(current.record.release.version).toBe(subject.plan.release.version);
      expect(current.record.toolchain.nodeArchiveSha256).toBe(subject.nodeArchiveSha256);
      expect(current.record.toolchain.pnpmArchiveSha256).toBe(subject.pnpmArchiveSha256);
      expect(current.record.launcherProtocol).toBe('revo-activation-launcher/v2');
      const generation = current.record.generationId;
      expect(await subject.startInstaller().finish).toBe(0);
      expect(await readFile(subject.calls, 'utf8')).toBe(downloads);
      expect(await readFile(subject.fetchCalls, 'utf8')).toBe(artifactRequests);
      expect(await readFile(subject.pnpmCalls, 'utf8')).toBe(pnpmInvocations);
      const retry = validActivation(await readActivation(join(subject.root, 'state', channel)));
      expect(retry.record.generationId).toBe(generation);
    } finally {
      await cleanupPortableToolchain(subject.root);
    }
  },
  180_000,
);

it.each(['extra-key', 'oversized', 'symlink'] as const)(
  'real helper rejects an unsafe %s request without changing current state',
  async (kind) => {
    const subject = await portableToolchain('stable', undefined, false, true);
    const requestRoot = await mkdtemp(join(subject.root, 'request-'));
    try {
      expect(await subject.startInstaller().finish).toBe(0);
      const before = validActivation(await readActivation(join(subject.root, 'state', 'stable')));
      const helper = join(
        subject.root,
        'state',
        'stable',
        before.record.packageRef,
        'dist/bin/revo-install-activate.js',
      );
      const valid = {
        schemaVersion: 'revo-install-activate/v1',
        channelRoot: join(subject.root, 'state'),
        packagePlan: subject.plan,
        nodeArchiveSha256: subject.nodeArchiveSha256,
        pnpmArchiveSha256: subject.pnpmArchiveSha256,
      };
      const requestPath = join(requestRoot, 'request.json');
      if (kind === 'extra-key') {
        await writeFile(requestPath, `${JSON.stringify({ ...valid, extra: true })}\n`, {
          mode: 0o600,
        });
      } else if (kind === 'oversized') {
        await writeFile(requestPath, `${'x'.repeat(64 * 1024 + 1)}\n`, { mode: 0o600 });
      } else {
        const targetPath = join(requestRoot, 'target.json');
        await writeFile(targetPath, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
        await symlink(targetPath, requestPath);
      }
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [helper, requestPath], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => (stderr += chunk));
        child.once('close', (code) => resolve({ code, stderr }));
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toBe('activation helper failed\n');
      expect(await readActivation(join(subject.root, 'state', 'stable'))).toEqual(before);
    } finally {
      await cleanupPortableToolchain(subject.root);
    }
  },
  180_000,
);

it('real activation refuses during startup and succeeds after the owner closes', async () => {
  const first = await portableToolchain('stable', undefined, false, true);
  const second = await portableToolchain('stable', '0.0.1', false, true, join(first.root, 'state'));
  const data = join(first.root, 'user-data');
  const scenario = await new ServerOwnerScenario().setup({ dataDir: data });
  let started: Awaited<ReturnType<ServerOwnerScenario['openInstalledCandidate']>> | undefined;
  try {
    await mkdir(data, { recursive: true, mode: 0o700 });
    await writeFile(join(data, 'sentinel'), 'sentinel\n');
    expect(await first.startInstaller({ REVO_DATA_DIR: data }).finish).toBe(0);
    const before = validActivation(await readActivation(join(first.root, 'state', 'stable')));
    const gate = join(first.root, 'state', 'stable', 'activation-barrier.gate');
    const marker = join(first.root, 'state', 'stable', 'activation-barrier.held');
    await writeFile(gate, 'hold\n', { mode: 0o600 });
    const prewarm = second.startInstaller({
      REVO_DATA_DIR: data,
      REVO_TEST_ACTIVATION_FAULT: 'cancel',
    });
    await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toContain('held'), {
      timeout: 120_000,
      interval: 25,
    });
    prewarm.child.kill('SIGTERM');
    expect(await prewarm.finish).not.toBe(0);
    expect(await readActivation(join(first.root, 'state', 'stable'))).toEqual(before);
    await rm(gate, { force: true });
    const channelRoot = join(first.root, 'state', 'stable');
    started = await scenario.openInstalledCandidate({
      channelRoot,
      generationId: before.record.generationId,
      version: before.record.release.version,
      executable: join(channelRoot, before.record.toolchain.nodeRef, 'bin', 'node'),
      coreEntry: join(channelRoot, before.record.packageRef, 'dist/bin/revo-core-host.js'),
    });
    expect(started.owner.status().phase).toBe('starting');
    expect(await second.startInstaller({ REVO_DATA_DIR: data }).finish).not.toBe(0);
    expect(await readActivation(join(first.root, 'state', 'stable'))).toEqual(before);
    started.releaseReady();
    await started.started;
    expect(started.owner.status().phase).toBe('running');
    expect(await second.startInstaller({ REVO_DATA_DIR: data }).finish).not.toBe(0);
    expect(await readActivation(join(first.root, 'state', 'stable'))).toEqual(before);
    await started.owner.close();
    expect(await second.startInstaller({ REVO_DATA_DIR: data }).finish).toBe(0);
    const after = validActivation(await readActivation(join(first.root, 'state', 'stable')));
    expect(after.record.generationId).not.toBe(before.record.generationId);
    expect(after.record.release.version).toBe('0.0.1');
    expect(await readFile(join(data, 'sentinel'), 'utf8')).toBe('sentinel\n');
  } finally {
    started?.releaseReady();
    await scenario.cleanup();
    await cleanupPortableToolchain(second.root);
    await cleanupPortableToolchain(first.root);
  }
}, 360_000);

it('real activation cancellation before commit preserves current and retains the attempt', async () => {
  const first = await portableToolchain('stable', undefined, false, true);
  const second = await portableToolchain('stable', '0.0.1', false, true, join(first.root, 'state'));
  const gate = join(first.root, 'state', 'stable', 'activation-barrier.gate');
  const marker = join(first.root, 'state', 'stable', 'activation-barrier.held');
  try {
    expect(await first.startInstaller().finish).toBe(0);
    const before = validActivation(await readActivation(join(first.root, 'state', 'stable')));
    await writeFile(gate, 'hold\n', { mode: 0o600 });
    const running = second.startInstaller({ REVO_TEST_ACTIVATION_FAULT: 'cancel' });
    await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toContain('held'), {
      timeout: 120_000,
      interval: 25,
    });
    running.child.kill('SIGTERM');
    expect(await running.finish).not.toBe(0);
    expect(await readActivation(join(first.root, 'state', 'stable'))).toEqual(before);
    expect(
      (await readdir(join(first.root, 'state', 'stable'))).some((name) =>
        name.startsWith('.attempt.'),
      ),
    ).toBe(true);
    await rm(gate, { force: true });
    expect(await second.startInstaller().finish).toBe(0);
    const after = validActivation(await readActivation(join(first.root, 'state', 'stable')));
    expect(after.record.generationId).not.toBe(before.record.generationId);
  } finally {
    await rm(gate, { force: true });
    await cleanupPortableToolchain(second.root);
    await cleanupPortableToolchain(first.root);
  }
}, 360_000);

it('real activation retains a committed generation when helper acknowledgement is lost', async () => {
  const first = await portableToolchain('stable', undefined, false, true);
  const second = await portableToolchain('stable', '0.0.1', false, true, join(first.root, 'state'));
  try {
    expect(await first.startInstaller().finish).toBe(0);
    const before = validActivation(await readActivation(join(first.root, 'state', 'stable')));
    const running = second.startInstaller({ REVO_TEST_ACTIVATION_FAULT: 'unknown' });
    expect(await running.finish).not.toBe(0);
    const committed = validActivation(await readActivation(join(first.root, 'state', 'stable')));
    expect(committed.record.generationId).not.toBe(before.record.generationId);
    expect(
      (await readdir(join(first.root, 'state', 'stable'))).some((name) =>
        name.startsWith('.attempt.'),
      ),
    ).toBe(true);
    expect(await second.startInstaller().finish).toBe(0);
    const retry = validActivation(await readActivation(join(first.root, 'state', 'stable')));
    expect(retry.record.generationId).toBe(committed.record.generationId);
  } finally {
    await cleanupPortableToolchain(second.root);
    await cleanupPortableToolchain(first.root);
  }
}, 360_000);

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
