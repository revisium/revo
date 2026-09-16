import { fork, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { acquireActivationOwnership } from '../../src/installation/activation-ownership.js';
import { activationOwnershipScenario } from '../support/installation/activation-ownership-scenario.js';

const OWNER_PROCESS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../support/installation/activation-owner-process.mjs',
);

function request(
  child: ChildProcess,
  message: Record<string, string>,
): Promise<{ status: string }> {
  return new Promise((resolveReply, rejectReply) => {
    const timeout = setTimeout(() => rejectReply(new Error('owner process did not reply')), 3_000);
    child.once('message', (reply: { status: string }) => {
      clearTimeout(timeout);
      resolveReply(reply);
    });
    child.send(message, (error) => {
      if (error !== null) {
        clearTimeout(timeout);
        rejectReply(error);
      }
    });
  });
}

async function channel(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'revo-owner-'));
  const stable = join(root, 'stable');
  await mkdir(stable, { mode: 0o700 });
  await chmod(stable, 0o700);
  const lock = await open(join(stable, '.activation.lock'), 'wx', 0o600);
  await lock.close();
  return stable;
}

describe('activation ownership', () => {
  it('holds one real lock, records its identity, and recovers after release', async () => {
    const root = await channel();
    try {
      const first = await acquireActivationOwnership({ channelRoot: root, channel: 'stable' });
      expect(first.status).toBe('held');
      if (first.status !== 'held') {
        return;
      }
      const record = JSON.parse(await readFile(join(root, '.activation-owner.json'), 'utf8'));
      expect(record.schemaVersion).toBe('revo-activation-owner/v1');
      expect(record.channel).toBe('stable');
      await first.lease.assertHeld();
      const busy = await acquireActivationOwnership({ channelRoot: root, channel: 'stable' });
      expect(busy.status).toBe('busy');
      await first.lease.release();
      const second = await acquireActivationOwnership({ channelRoot: root, channel: 'stable' });
      expect(second.status).toBe('held');
      if (second.status === 'held') {
        await second.lease.release();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not create an absent channel or lock on cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-owner-'));
    const signal = AbortSignal.abort();
    try {
      const result = await acquireActivationOwnership({
        channelRoot: join(root, 'stable'),
        channel: 'stable',
        signal,
      });
      expect(result).toEqual({ status: 'cancelled' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the lease for an atomic activation and then reacquires it', async () => {
    const scenario = await activationOwnershipScenario();
    try {
      expect((await scenario.activateOwned()).status).toBe('activated');
      await scenario.reacquire();
    } finally {
      await scenario.cleanup();
    }
  });

  it('fails closed for malformed owner state and preserves its bytes', async () => {
    const root = await channel();
    const ownerPath = join(root, '.activation-owner.json');
    const bytes = '{"not":"an owner"}';
    await writeFile(ownerPath, bytes, { mode: 0o600 });
    try {
      expect(await acquireActivationOwnership({ channelRoot: root, channel: 'stable' })).toEqual({
        status: 'unavailable',
        reason: 'activation owner unavailable',
      });
      expect(await readFile(ownerPath, 'utf8')).toBe(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers a stale identity but rejects an unsafe lock', async () => {
    const root = await channel();
    const ownerPath = join(root, '.activation-owner.json');
    const first = await acquireActivationOwnership({ channelRoot: root, channel: 'stable' });
    expect(first.status).toBe('held');
    if (first.status !== 'held') {
      return;
    }
    const stale = (await readFile(ownerPath, 'utf8')).replace(/"pid":\d+/u, '"pid":1');
    await first.lease.release();
    await writeFile(ownerPath, stale, { mode: 0o600 });
    const recovered = await acquireActivationOwnership({ channelRoot: root, channel: 'stable' });
    expect(recovered.status).toBe('held');
    if (recovered.status === 'held') {
      await recovered.lease.release();
    }
    await chmod(join(root, '.activation.lock'), 0o644);
    expect(await acquireActivationOwnership({ channelRoot: root, channel: 'stable' })).toEqual({
      status: 'unavailable',
      reason: 'activation lock unavailable',
    });
    await rm(root, { recursive: true, force: true });
  });

  it('does not delete a foreign owner after lock pathname replacement', async () => {
    const root = await channel();
    const lockPath = join(root, '.activation.lock');
    const ownerPath = join(root, '.activation-owner.json');
    const held = await acquireActivationOwnership({ channelRoot: root, channel: 'stable' });
    expect(held.status).toBe('held');
    if (held.status !== 'held') {
      return;
    }
    const bytes = await readFile(ownerPath);
    await rename(lockPath, join(root, '.activation-lock-old'));
    const replacement = await open(lockPath, 'wx', 0o600);
    await replacement.close();
    await expect(held.lease.assertHeld()).rejects.toThrow('unsafe lock');
    await held.lease.release();
    expect(await readFile(ownerPath)).toEqual(bytes);
    await rm(root, { recursive: true, force: true });
  });

  it('recovers a stale owner after the holding process is killed', async () => {
    const root = await channel();
    const child = fork(OWNER_PROCESS, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      expect(await request(child, { action: 'acquire', root, channel: 'stable' })).toEqual({
        status: 'held',
      });
      const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
      child.kill('SIGKILL');
      await exited;
      const recovered = await acquireActivationOwnership({ channelRoot: root, channel: 'stable' });
      expect(recovered.status).toBe('held');
      if (recovered.status === 'held') {
        await recovered.lease.release();
      }
    } finally {
      child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  });
});
