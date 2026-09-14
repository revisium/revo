import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OwnershipScenario } from '../support/ownership/ownership-scenario.js';

describe('server ownership', () => {
  let scenario: OwnershipScenario;

  beforeEach(async () => {
    scenario = await new OwnershipScenario().setup();
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it('allows exactly one simultaneous owner for a canonical data directory', async () => {
    const first = await scenario.owner();
    const second = await scenario.owner();

    const results = await Promise.all([
      first.request('acquire', scenario.dataDir()),
      second.request('acquire', scenario.dataDir()),
    ]);

    expect(
      results.map(({ kind }) => String(kind)).sort((left, right) => left.localeCompare(right)),
    ).toEqual(['busy', 'held']);
  });

  it('acquires ownership through the real Nest module', async () => {
    expect(await scenario.acquireThroughNest(scenario.dataDir())).toMatchObject({ kind: 'held' });
  });

  it('contends through a symlink alias while independent directories do not contend', async () => {
    const second = await scenario.owner();
    const dataDir = scenario.dataDir();
    await scenario.acquire(dataDir);

    expect(await second.request('acquire', await scenario.aliasFor(dataDir))).toMatchObject({
      kind: 'busy',
    });
    expect(await scenario.acquire(scenario.dataDir('other'))).toMatchObject({ kind: 'held' });
  });

  it('keeps the lock inode and supports release followed by reacquisition', async () => {
    const first = await scenario.acquire(scenario.dataDir());
    const before = await scenario.identity(scenario.dataDir());
    expect(first.kind).toBe('held');
    if (first.kind === 'held') {
      await first.release();
    }
    expect(await scenario.acquire(scenario.dataDir())).toMatchObject({ kind: 'held' });

    expect(await scenario.identity(scenario.dataDir())).toEqual(before);
  });

  it('does not let an idempotent old release unlock a new owner', async () => {
    const first = await scenario.acquire(scenario.dataDir());
    const second = await scenario.owner();
    const observer = await scenario.owner();
    expect(first.kind).toBe('held');
    if (first.kind !== 'held') {
      throw new Error('Expected the first ownership lease to be held.');
    }
    await first.release();
    await second.request('acquire', scenario.dataDir());

    await first.release();

    expect(await observer.request('acquire', scenario.dataDir())).toMatchObject({ kind: 'busy' });
  });

  it('surfaces a native release failure once and remains idempotent', async () => {
    const lease = await scenario.leaseWithFailingRelease();

    await expect(lease.release()).rejects.toThrow('Unable to release server ownership lock');
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('surfaces a native acquire failure and closes its descriptor', async () => {
    await expect(scenario.failNativeAcquire()).rejects.toThrow(/ownership lock/u);
    expect(scenario.failedNativeDescriptorIsClosed()).toBe(true);

    await expect(scenario.acquire(scenario.dataDir())).resolves.toMatchObject({ kind: 'held' });
  });

  it('releases kernel ownership after a killed owner', async () => {
    const first = await scenario.owner();
    const next = await scenario.owner();
    await first.request('acquire', scenario.dataDir());

    await first.kill();

    expect(await next.request('acquire', scenario.dataDir())).toMatchObject({ kind: 'held' });
  });

  it('fails a request against a killed owner promptly with its action labelled', async () => {
    const owner = await scenario.owner();
    await owner.kill();

    const startedAt = Date.now();
    await expect(owner.request('acquire', scenario.dataDir())).rejects.toThrow(
      /request "acquire" did not reply: child already exited/u,
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('does not pass ownership to an unrelated long-lived child', async () => {
    const first = await scenario.owner();
    const next = await scenario.owner();
    await first.request('acquire', scenario.dataDir());
    const pid = await scenario.spawnUnrelated(first);

    await first.kill();

    expect(scenario.processExists(pid)).toBe(true);
    expect(await next.request('acquire', scenario.dataDir())).toMatchObject({ kind: 'held' });
  });

  it('opens the ownership descriptor close-on-exec on the current platform', async () => {
    const owner = await scenario.owner();

    expect(await owner.request('probe-cloexec', scenario.dataDir())).toMatchObject({
      closeOnExec: true,
    });
  });

  it.each([
    [
      'a non-private data directory',
      async (fixture: OwnershipScenario) => fixture.insecureDataDir(),
    ],
    ['a symlink lock', async (fixture: OwnershipScenario) => fixture.symlinkLock()],
    ['a non-regular lock', async (fixture: OwnershipScenario) => fixture.nonRegularLock()],
  ])('fails closed for %s', async (_case, arrange) => {
    await expect(scenario.acquire(await arrange(scenario))).rejects.toThrow(/.+/u);
  });
});
