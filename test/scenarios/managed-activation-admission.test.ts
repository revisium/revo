import { describe, expect, it } from 'vitest';

import { acquireActivationOwnership } from '../../src/installation/activation-ownership.js';
import type { ServerOwnership } from '../../src/processes/ownership.types.js';
import { ServerOwnershipService } from '../../src/processes/server-ownership.service.js';
import { managedActivationScenario } from '../support/installation/managed-activation-scenario.js';
import { OwnershipScenario } from '../support/ownership/ownership-scenario.js';

describe('managed activation admission', () => {
  it('reports server-busy while a real child holds the same data lock', async () => {
    const ownership = await new OwnershipScenario().setup();
    const s = await managedActivationScenario({ dataDir: ownership.dataDir() });
    const child = await ownership.owner();
    try {
      await expect(s.activate()).resolves.toMatchObject({ status: 'activated' });
      const before = await s.pointer();
      await expect(child.request('acquire', s.stableData)).resolves.toMatchObject({ kind: 'held' });
      await expect(s.activateNext()).resolves.toEqual({ status: 'server-busy' });
      expect(await s.pointer()).toBe(before);
      expect(await s.userData()).toBe('keep');
      await expect(child.request('release', s.stableData)).resolves.toMatchObject({
        released: true,
      });
    } finally {
      await s.release();
      await ownership.cleanup();
    }
  });

  it('holds both native leases behind IPC, then commits and releases them', async () => {
    const ownership = await new OwnershipScenario().setup();
    const s = await managedActivationScenario({ dataDir: ownership.dataDir() });
    const child = await ownership.owner();
    try {
      await expect(s.activate()).resolves.toMatchObject({ status: 'activated' });
      const before = await s.pointer();
      const barrier = child.request('activate-managed', undefined, {
        channelRoot: s.channelRoot,
        candidate: s.next,
        configuration: s.configuration(),
      });
      await expect(barrier).resolves.toMatchObject({ phase: 'before-commit' });
      await expect(ownership.acquire(s.stableData)).resolves.toMatchObject({ kind: 'busy' });
      await expect(
        acquireActivationOwnership({ channelRoot: s.channelRoot, channel: 'stable' }),
      ).resolves.toMatchObject({ status: 'busy' });
      expect(await s.pointer()).toBe(before);
      await expect(child.request('continue-activation')).resolves.toMatchObject({
        continued: true,
      });
      await expect(child.request('wait-activation')).resolves.toMatchObject({
        outcome: { status: 'activated' },
      });
      expect(await s.pointer()).not.toBe(before);
      await expect(ownership.acquire(s.stableData)).resolves.toMatchObject({ kind: 'held' });
      const activation = await acquireActivationOwnership({
        channelRoot: s.channelRoot,
        channel: 'stable',
      });
      expect(activation.status).toBe('held');
      if (activation.status === 'held') {
        await activation.lease.release();
      }
    } finally {
      await child.request('continue-activation').catch(() => undefined);
      await child.kill().catch(() => undefined);
      await s.release();
      await ownership.cleanup();
    }
  });

  it('reuses a healthy identity while the server lock is held', async () => {
    const s = await managedActivationScenario();
    try {
      await expect(s.activate()).resolves.toMatchObject({ status: 'activated' });
      const before = await s.pointer();
      const held = await s.holdServer();
      expect(held.kind).toBe('held');
      if (held.kind !== 'held') {
        return;
      }
      try {
        await expect(s.activate()).resolves.toMatchObject({ status: 'unchanged' });
        expect(await s.pointer()).toBe(before);
        expect(await s.userData()).toBe('keep');
      } finally {
        await held.release();
      }
    } finally {
      await s.release();
    }
  });

  it('rejects identity changes while running, then activates after stop', async () => {
    const s = await managedActivationScenario();
    try {
      await expect(s.activate()).resolves.toMatchObject({ status: 'activated' });
      const before = await s.pointer();
      const held = await s.holdServer();
      expect(held.kind).toBe('held');
      if (held.kind !== 'held') {
        return;
      }
      try {
        await expect(s.activateNext()).resolves.toEqual({ status: 'server-busy' });
      } finally {
        await held.release();
      }
      expect(await s.pointer()).toBe(before);
      await expect(s.activateNext()).resolves.toMatchObject({ status: 'activated' });
      expect(await s.userData()).toBe('keep');
    } finally {
      await s.release();
    }
  });

  it('fails closed for invalid state, unsafe artifacts, and channel mismatch', async () => {
    const s = await managedActivationScenario();
    try {
      await expect(s.activate()).resolves.toMatchObject({ status: 'activated' });
      const before = await s.pointer();
      await expect(
        s.activate({ ...s.first, nodeArchiveSha256: 'f'.repeat(64) }),
      ).resolves.toMatchObject({ status: 'unavailable' });
      expect(await s.pointer()).toBe(before);
      await s.corruptPointer();
      await expect(s.activateNext()).resolves.toMatchObject({ status: 'unavailable' });
      await s.setPackageBinMode(0o622);
      await expect(s.activate()).resolves.toMatchObject({ status: 'unavailable' });
      await s.setPackageBinMode(0o755);
      await s.replaceDataDirectory();
      await expect(s.activateNext()).resolves.toMatchObject({ status: 'unavailable' });
      await s.restoreDataDirectory();
      const alpha = {
        ...s.next,
        plan: { ...s.next.plan, release: { ...s.next.plan.release, channel: 'alpha' as const } },
      };
      await expect(s.activate(alpha)).resolves.toEqual({ status: 'unavailable' });
    } finally {
      await s.release();
    }
  });

  it('honors pre-abort and keeps stable and alpha data isolated', async () => {
    const s = await managedActivationScenario();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(s.activate(s.first, controller.signal)).resolves.toEqual({
        status: 'cancelled',
      });
      await expect(s.activate()).resolves.toMatchObject({ status: 'activated' });
      expect(await s.dataExists()).toBe(true);
      expect(await s.alphaDataExists()).toBe(true);
    } finally {
      await s.release();
    }
  });

  it('cancels after asynchronous admission and before pointer publication', async () => {
    let calls = 0;
    let controller!: AbortController;
    const acquire = async (input: Parameters<typeof acquireActivationOwnership>[0]) => {
      const result = await acquireActivationOwnership(input);
      if (result.status !== 'held') {
        return result;
      }
      return {
        ...result,
        lease: {
          ...result.lease,
          assertHeld: async () => {
            await result.lease.assertHeld();
            if (++calls === 3) {
              controller.abort();
            }
          },
        },
      };
    };
    const s = await managedActivationScenario({ acquireOwnership: acquire });
    controller = new AbortController();
    try {
      await expect(s.activate(s.first, controller.signal)).resolves.toEqual({
        status: 'cancelled',
      });
      await expect(s.pointer()).rejects.toBeDefined();
    } finally {
      await s.release();
    }
  });

  it('reports unknown outcome while releasing both ownership leases', async () => {
    const server = new (class extends ServerOwnershipService {
      override async acquire(): Promise<ServerOwnership> {
        return {
          kind: 'held',
          lockPath: 'test',
          release: async () => {
            throw new Error('server cleanup');
          },
        };
      }
    })();
    const acquire = async (input: Parameters<typeof acquireActivationOwnership>[0]) => {
      const result = await acquireActivationOwnership(input);
      return result.status !== 'held'
        ? result
        : {
            ...result,
            lease: {
              ...result.lease,
              release: async () => {
                await result.lease.release();
                throw new Error('activation cleanup');
              },
            },
          };
    };
    const s = await managedActivationScenario({ acquireOwnership: acquire, server });
    try {
      await expect(s.activate()).resolves.toEqual({ status: 'outcome-unknown' });
    } finally {
      await s.release();
    }
  });

  it('does not overwrite a newer current generation after a stale read', async () => {
    let s: Awaited<ReturnType<typeof managedActivationScenario>>;
    const server = new (class extends ServerOwnershipService {
      override async acquire(): Promise<ServerOwnership> {
        await s.activateNextRaw();
        return { kind: 'held', lockPath: 'test', release: async () => undefined };
      }
    })();
    s = await managedActivationScenario({ server });
    try {
      await expect(s.activate()).resolves.toEqual({ status: 'busy' });
      expect(await s.pointer()).toBe(`activations/${await s.currentGeneration()}`);
    } finally {
      await s.release();
    }
  });
});
