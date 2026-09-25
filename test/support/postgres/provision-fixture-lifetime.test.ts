import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagedProcessRequest } from '../../../src/processes/managed-process.types.js';
import {
  PublishedControlError,
  PublishedControlService,
} from '../../../src/processes/published-control.service.js';
import { FailingCancellationProcess, PostgresScenario } from './postgres-scenario.js';
import {
  ProvisionFixtureLifetime,
  type ProvisionFixtureOwner,
} from './provision-fixture-lifetime.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: vi.fn<typeof actual.chmod>(actual.chmod),
    mkdir: vi.fn<typeof actual.mkdir>(actual.mkdir),
    mkdtemp: vi.fn<typeof actual.mkdtemp>(actual.mkdtemp),
  };
});

type Fixture = { readonly root: string };
type Acquisition =
  | { readonly kind: 'held'; readonly owner: ProvisionFixtureOwner }
  | { readonly kind: 'busy' };

const roots: string[] = [];
let actualFs: typeof import('node:fs/promises');

beforeEach(async () => {
  actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(chmod).mockReset().mockImplementation(actualFs.chmod);
  vi.mocked(mkdir).mockReset().mockImplementation(actualFs.mkdir);
  vi.mocked(mkdtemp).mockReset().mockImplementation(actualFs.mkdtemp);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function fixture(scope: ReturnType<ProvisionFixtureLifetime['scope']>): Promise<Fixture> {
  return scope.create(async (registerRoot) => {
    const root = await mkdtemp(join(tmpdir(), 'revo-provision-lifetime-'));
    roots.push(root);
    registerRoot(root);
    return { root };
  });
}

function acquired(owner: ProvisionFixtureOwner): Acquisition {
  return { kind: 'held', owner };
}

function createOwner(
  close: () => Promise<void>,
  released: () => Promise<void>,
): ProvisionFixtureOwner {
  return { close, ownershipReleased: released };
}

function isOwner(result: Acquisition) {
  return result.kind === 'held' ? result.owner : undefined;
}

function isBusy(result: Acquisition) {
  return result.kind === 'busy';
}

function containsError(error: unknown, expected: unknown): boolean {
  return (
    error === expected ||
    (error instanceof AggregateError &&
      error.errors.some((nested) => containsError(nested, expected)))
  );
}

function countErrorOccurrences(error: unknown, expected: unknown): number {
  if (error === expected) {
    return 1;
  }
  return error instanceof AggregateError
    ? error.errors.reduce((count, nested) => count + countErrorOccurrences(nested, expected), 0)
    : 0;
}

function countNamedErrors(error: unknown, expectedName: string): number {
  if (error instanceof AggregateError) {
    return (
      Number(error.name === expectedName) +
      error.errors.reduce((count, nested) => count + countNamedErrors(nested, expectedName), 0)
    );
  }
  return error instanceof Error && error.name === expectedName ? 1 : 0;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.mocked(chmod).mockReset().mockImplementation(actualFs.chmod);
  vi.mocked(mkdir).mockReset().mockImplementation(actualFs.mkdir);
  vi.mocked(mkdtemp).mockReset().mockImplementation(actualFs.mkdtemp);
});

describe('provision fixture lifetime', () => {
  it('registers and removes a root created after cleanup begins', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const permitCreation = deferred<void>();
    let root: string | undefined;
    const creating = scope.create(async (registerRoot) => {
      await permitCreation.promise;
      const createdRoot = await mkdtemp(join(tmpdir(), 'revo-provision-late-root-'));
      root = createdRoot;
      roots.push(createdRoot);
      registerRoot(createdRoot);
      return { root: createdRoot };
    });
    const cleaning = lifetime.cleanup();
    permitCreation.resolve();

    await expect(creating).rejects.toThrow('Provision fixture is closing');
    await cleaning;
    expect(root).toBeDefined();
    if (root === undefined) {
      throw new Error('late fixture root was not registered');
    }
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('closes a held owner that arrives from a pending acquisition', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const result = deferred<Acquisition>();
    let closeCalls = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const lateOwner = createOwner(
      async () => {
        closeCalls += 1;
        release();
      },
      () => released,
    );
    const acquisition = scope.acquire(() => result.promise, isOwner, isBusy);
    const cleaning = lifetime.cleanup();
    result.resolve(acquired(lateOwner));

    await acquisition;
    await cleaning;
    expect(closeCalls).toBe(1);
    await expect(lstat(current.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not touch an unowned busy server and retains its root', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const result = deferred<Acquisition>();
    let foreignCloseCalls = 0;
    createOwner(
      async () => {
        foreignCloseCalls += 1;
      },
      async () => undefined,
    );
    const acquisition = scope.acquire(() => result.promise, isOwner, isBusy);
    const cleaning = lifetime.cleanup();
    result.resolve({ kind: 'busy' });
    await acquisition;

    await expect(cleaning).rejects.toThrow('unresolved roots retained');
    expect(foreignCloseCalls).toBe(0);
    await expect(lstat(current.root)).resolves.toBeDefined();
  });

  it('retains the root when acquisition fails without release proof', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const failure = new PublishedControlError('startup', [], 'unconfirmed');
    await expect(scope.acquire(() => Promise.reject(failure), isOwner, isBusy)).rejects.toBe(
      failure,
    );

    await expect(lifetime.cleanup()).rejects.toThrow('unresolved roots retained');
    await expect(lstat(current.root)).resolves.toBeDefined();
  });

  it('closes every acquired owner and preserves the primary scenario error', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const primary = new Error('primary provision failure');
    const closed: number[] = [];
    const makeOwner = (id: number) =>
      createOwner(
        async () => {
          closed.push(id);
        },
        async () => undefined,
      );

    await expect(
      scope.run(async () => {
        await scope.acquire(async () => acquired(makeOwner(1)), isOwner, isBusy);
        await scope.acquire(async () => acquired(makeOwner(2)), isOwner, isBusy);
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(closed.sort((left, right) => left - right)).toEqual([1, 2]);
    await expect(lstat(current.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('observes coalesced work without replacing its promise identity', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    await fixture(scope);
    const pending = Promise.resolve('same operation');

    expect(scope.observe(pending)).toBe(pending);
    expect(scope.observe(pending)).toBe(pending);
    await scope.run(async () => pending);
  });

  it('accepts an explicitly classified close rejection after confirmed release', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const expected = new PublishedControlError('close', [], 'released');
    const held = createOwner(
      () => Promise.reject(expected),
      async () => undefined,
    );
    await scope.acquire(
      async () => acquired(held),
      isOwner,
      isBusy,
      (error) => error === expected,
    );

    await lifetime.cleanup();
    await expect(lstat(current.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a root for unconfirmed release, then allows a confirmed retry', async () => {
    vi.useFakeTimers();
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const release = deferred<void>();
    const expected = new PublishedControlError('close', [], 'released');
    const held = createOwner(
      () => Promise.reject(expected),
      () => release.promise,
    );
    await scope.acquire(
      async () => acquired(held),
      isOwner,
      isBusy,
      (error) => error === expected,
    );
    const cleaning = lifetime.cleanup();
    const outcome = cleaning.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await vi.advanceTimersByTimeAsync(7_001);
    expect((await outcome).kind).toBe('rejected');
    await expect(lstat(current.root)).resolves.toBeDefined();

    release.resolve();
    await Promise.resolve();
    await expect(lifetime.cleanup()).resolves.toBeUndefined();
    await expect(lstat(current.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('re-observes a pending close after timeout and removes the root after late success', async () => {
    vi.useFakeTimers();
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const close = deferred<void>();
    const release = deferred<void>();
    const held = createOwner(
      () => close.promise,
      () => release.promise,
    );
    await scope.acquire(async () => acquired(held), isOwner, isBusy);

    const firstCleanup = lifetime.cleanup().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await vi.advanceTimersByTimeAsync(7_001);
    expect((await firstCleanup).kind).toBe('rejected');
    await expect(lstat(current.root)).resolves.toBeDefined();

    close.resolve();
    release.resolve();
    await Promise.resolve();
    await expect(lifetime.cleanup()).resolves.toBeUndefined();
    await expect(lstat(current.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains the root when release is confirmed but close remains pending', async () => {
    vi.useFakeTimers();
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const close = deferred<void>();
    const held = createOwner(
      () => close.promise,
      async () => undefined,
    );
    await scope.acquire(async () => acquired(held), isOwner, isBusy);

    const firstCleanup = lifetime.cleanup().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await vi.advanceTimersByTimeAsync(7_001);
    expect((await firstCleanup).kind).toBe('rejected');
    await expect(lstat(current.root)).resolves.toBeDefined();

    close.resolve();
    await Promise.resolve();
    await expect(lifetime.cleanup()).resolves.toBeUndefined();
    await expect(lstat(current.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('drains a close added during observation within the original deadline', async () => {
    vi.useFakeTimers();
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const firstClose = deferred<void>();
    const secondClose = deferred<void>();
    const release = deferred<void>();
    const releaseEntered = deferred<void>();
    let closeCalls = 0;
    const held = createOwner(
      () => {
        closeCalls += 1;
        return closeCalls === 1 ? firstClose.promise : secondClose.promise;
      },
      () => {
        releaseEntered.resolve();
        return release.promise;
      },
    );
    await scope.acquire(async () => acquired(held), isOwner, isBusy);

    const cleaning = lifetime.cleanup();
    const cleanupOutcome = cleaning.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await releaseEntered.promise;
    await vi.advanceTimersByTimeAsync(6_990);
    const secondCloseOutcome = scope.requestOwnerClose(held).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    firstClose.resolve();
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(lstat(current.root)).resolves.toBeDefined();

    let cleanupSettled = false;
    void cleanupOutcome.then(() => {
      cleanupSettled = true;
    });
    await vi.advanceTimersByTimeAsync(9);
    expect(cleanupSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await cleanupOutcome).kind).toBe('rejected');
    await expect(lstat(current.root)).resolves.toBeDefined();

    secondClose.resolve();
    expect((await secondCloseOutcome).kind).toBe('resolved');
    await Promise.resolve();
    await expect(lifetime.cleanup()).resolves.toBeUndefined();
    expect(closeCalls).toBe(2);
    await expect(lstat(current.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a late actual close rejection after the observation timeout', async () => {
    vi.useFakeTimers();
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const close = deferred<void>();
    const lateFailure = new Error('late close rejection');
    let closeCalls = 0;
    const held = createOwner(
      () => {
        closeCalls += 1;
        return closeCalls === 1 ? close.promise : Promise.resolve();
      },
      async () => undefined,
    );
    await scope.acquire(async () => acquired(held), isOwner, isBusy);

    const firstCleanup = lifetime.cleanup().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await vi.advanceTimersByTimeAsync(7_001);
    expect((await firstCleanup).kind).toBe('rejected');
    close.reject(lateFailure);
    await Promise.resolve();

    const retryFailure = await lifetime.cleanup().catch((error: unknown) => error);
    expect(containsError(retryFailure, lateFailure)).toBe(true);
    await expect(lstat(current.root)).resolves.toBeDefined();
  });

  it('keeps each actual close rejection after later failures and a successful retry', async () => {
    vi.useFakeTimers();
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const firstFailure = new Error('first close failure');
    const secondFailure = new Error('late second close failure');
    const secondClose = deferred<void>();
    const secondCloseEntered = deferred<void>();
    let closeCalls = 0;
    const held = createOwner(
      () => {
        closeCalls += 1;
        if (closeCalls === 1) {
          return Promise.reject(firstFailure);
        }
        if (closeCalls === 2) {
          secondCloseEntered.resolve();
          return secondClose.promise;
        }
        return Promise.resolve();
      },
      async () => undefined,
    );
    await scope.acquire(async () => acquired(held), isOwner, isBusy);
    await expect(scope.requestOwnerClose(held)).rejects.toBe(firstFailure);

    const firstCleanup = lifetime.cleanup().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await secondCloseEntered.promise;
    await vi.advanceTimersByTimeAsync(7_001);
    const firstCleanupResult = await firstCleanup;
    expect(firstCleanupResult.kind).toBe('rejected');
    if (firstCleanupResult.kind !== 'rejected') {
      throw new Error('pending close was not reported as unconfirmed');
    }
    expect(containsError(firstCleanupResult.error, firstFailure)).toBe(true);
    expect(containsError(firstCleanupResult.error, secondFailure)).toBe(false);
    await expect(lstat(current.root)).resolves.toBeDefined();

    secondClose.reject(secondFailure);
    await Promise.resolve();
    const retryFailure = await lifetime.cleanup().catch((error: unknown) => error);
    expect(containsError(retryFailure, firstFailure)).toBe(true);
    expect(containsError(retryFailure, secondFailure)).toBe(true);
    const laterRetryFailure = await lifetime.cleanup().catch((error: unknown) => error);
    expect(containsError(laterRetryFailure, firstFailure)).toBe(true);
    expect(containsError(laterRetryFailure, secondFailure)).toBe(true);
    expect(closeCalls).toBe(3);
    await expect(lstat(current.root)).resolves.toBeDefined();
  });

  it('deduplicates a repeated close rejection by object identity', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const closeFailure = new Error('same close rejection');
    let closeCalls = 0;
    const held = createOwner(
      () => {
        closeCalls += 1;
        return closeCalls < 3 ? Promise.reject(closeFailure) : Promise.resolve();
      },
      async () => undefined,
    );
    await scope.acquire(async () => acquired(held), isOwner, isBusy);
    await expect(scope.requestOwnerClose(held)).rejects.toBe(closeFailure);
    await expect(lifetime.cleanup()).rejects.toThrow('unresolved roots retained');

    const retryFailure = await lifetime.cleanup().catch((error: unknown) => error);
    expect(countErrorOccurrences(retryFailure, closeFailure)).toBe(1);
    expect(closeCalls).toBe(3);
    await expect(lstat(current.root)).resolves.toBeDefined();
  });

  it('does not mistake a real release rejection for an observation timeout by message', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const releaseFailure = new Error('Fixture cleanup remains unconfirmed');
    let releaseCalls = 0;
    const held = createOwner(
      async () => undefined,
      () => {
        releaseCalls += 1;
        return releaseCalls === 1 ? Promise.reject(releaseFailure) : Promise.resolve();
      },
    );
    await scope.acquire(async () => acquired(held), isOwner, isBusy);

    await expect(lifetime.cleanup()).rejects.toThrow('unresolved roots retained');
    const retryFailure = await lifetime.cleanup().catch((error: unknown) => error);
    expect(containsError(retryFailure, releaseFailure)).toBe(true);
    expect(releaseCalls).toBe(1);
    await expect(lstat(current.root)).resolves.toBeDefined();
  });

  it('runs a pending finalizer only once and allows cleanup after its late success', async () => {
    vi.useFakeTimers();
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const finalizer = deferred<void>();
    let calls = 0;
    scope.beforeClose(() => {
      calls += 1;
      return finalizer.promise;
    });

    const firstCleanup = lifetime.cleanup().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await vi.advanceTimersByTimeAsync(7_001);
    expect((await firstCleanup).kind).toBe('rejected');
    await expect(lstat(current.root)).resolves.toBeDefined();

    finalizer.resolve();
    await Promise.resolve();
    await expect(lifetime.cleanup()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    await expect(lstat(current.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a late finalizer rejection and still closes every owner', async () => {
    vi.useFakeTimers();
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const finalizer = deferred<void>();
    const finalizerFailure = new Error('late finalizer failure');
    let finalizerCalls = 0;
    let closeCalls = 0;
    scope.beforeClose(() => {
      finalizerCalls += 1;
      return finalizer.promise;
    });
    await scope.acquire(
      async () =>
        acquired(
          createOwner(
            async () => {
              closeCalls += 1;
            },
            async () => undefined,
          ),
        ),
      isOwner,
      isBusy,
    );

    const firstCleanup = lifetime.cleanup().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await vi.advanceTimersByTimeAsync(7_001);
    expect((await firstCleanup).kind).toBe('rejected');
    expect(closeCalls).toBe(1);
    finalizer.reject(finalizerFailure);
    await Promise.resolve();

    const retryFailure = await lifetime.cleanup().catch((error: unknown) => error);
    expect(containsError(retryFailure, finalizerFailure)).toBe(true);
    expect(finalizerCalls).toBe(1);
    expect(closeCalls).toBe(1);
    await expect(lstat(current.root)).resolves.toBeDefined();
  });

  it('retains a root while fixture creation is inside a pending setup operation', async () => {
    vi.useFakeTimers();
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const setup = deferred<void>();
    let root: string | undefined;
    const creation = scope.create(async (registerRoot) => {
      const createdRoot = await mkdtemp(join(tmpdir(), 'revo-provision-pending-'));
      root = createdRoot;
      roots.push(createdRoot);
      registerRoot(createdRoot);
      await setup.promise;
      return { root: createdRoot };
    });
    const creationOutcome = creation.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    const firstCleanup = lifetime.cleanup().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await vi.advanceTimersByTimeAsync(7_001);
    expect((await firstCleanup).kind).toBe('rejected');
    if (root === undefined) {
      throw new Error('fixture root was not registered');
    }
    await expect(lstat(root)).resolves.toBeDefined();

    setup.resolve();
    expect((await creationOutcome).kind).toBe('rejected');
    await expect(lifetime.cleanup()).resolves.toBeUndefined();
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a setup failure and does not start later setup operations', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const primary = new Error('data directory setup failed');
    const steps: string[] = [];
    let root: string | undefined;

    await expect(
      scope.run(async () =>
        scope.create(async (registerRoot) => {
          const createdRoot = await mkdtemp(join(tmpdir(), 'revo-provision-setup-failure-'));
          root = createdRoot;
          roots.push(createdRoot);
          registerRoot(createdRoot);
          const setup = async (step: string) => {
            steps.push(step);
            if (step === 'data directory') {
              throw primary;
            }
          };
          await setup('data directory');
          await setup('runtime directory');
          return { root: createdRoot };
        }),
      ),
    ).rejects.toBe(primary);
    expect(steps).toEqual(['data directory']);
    if (root === undefined) {
      throw new Error('fixture root was not registered');
    }
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['mkdir:data', 'mkdir:run', 'chmod:data', 'chmod:run'] as const)(
    'preserves the primary failure from the real scenario fixture at %s',
    async (failedOperation) => {
      const scenario = new PostgresScenario();
      const entered = deferred<void>();
      const gate = deferred<void>();
      const primary = new Error(`${failedOperation} failed`);
      const operations = ['mkdir:data', 'mkdir:run', 'chmod:data', 'chmod:run'] as const;
      const expectedCalls = operations.slice(0, operations.indexOf(failedOperation) + 1);
      const calls: string[] = [];
      let root: string | undefined;
      let run: Promise<unknown> | undefined;
      let gateReleased = false;
      const open = vi.spyOn(PublishedControlService.prototype, 'open').mockImplementation(() => {
        throw new Error('PostgreSQL acquisition must not run during fixture setup tests');
      });

      vi.mocked(mkdtemp).mockImplementation(async (prefix) => {
        const createdRoot = await actualFs.mkdtemp(prefix);
        if (prefix === '/tmp/pg-') {
          root = createdRoot;
          roots.push(createdRoot);
        }
        return createdRoot;
      });
      vi.mocked(mkdir).mockImplementation(async (path, options) => {
        const candidate = String(path);
        if (root !== undefined && candidate.startsWith(`${root}/`)) {
          const operation = `mkdir:${candidate.slice(root.length + 1)}`;
          calls.push(operation);
          if (operation === failedOperation) {
            entered.resolve();
            await gate.promise;
            throw primary;
          }
        }
        return actualFs.mkdir(path, options);
      });
      vi.mocked(chmod).mockImplementation(async (path, mode) => {
        const candidate = String(path);
        if (root !== undefined && candidate.startsWith(`${root}/`)) {
          const operation = `chmod:${candidate.slice(root.length + 1)}`;
          calls.push(operation);
          if (operation === failedOperation) {
            entered.resolve();
            await gate.promise;
            throw primary;
          }
        }
        return actualFs.chmod(path, mode);
      });

      try {
        run = scenario.provisionAndReopen();
        await entered.promise;
        expect(calls).toEqual(expectedCalls);
        gate.reject(primary);
        gateReleased = true;
        await expect(run).rejects.toBe(primary);
        expect(calls).toEqual(expectedCalls);
        expect(open).not.toHaveBeenCalled();
        if (root === undefined) {
          throw new Error('PostgresScenario.fixture did not register its root');
        }
        await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (!gateReleased) {
          gate.reject(primary);
        }
        await run?.catch(() => undefined);
        await scenario.cleanup().catch(() => undefined);
        open.mockRestore();
      }
    },
  );

  it('retains the actual scenario fixture root while a filesystem operation is pending', async () => {
    const scenario = new PostgresScenario();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const primary = new Error('held mkdir(data) failed');
    const calls: string[] = [];
    let root: string | undefined;
    let run: Promise<unknown> | undefined;
    let cleaning: Promise<void> | undefined;
    let gateReleased = false;
    const open = vi.spyOn(PublishedControlService.prototype, 'open').mockImplementation(() => {
      throw new Error('PostgreSQL acquisition must not run during fixture setup tests');
    });

    vi.mocked(mkdtemp).mockImplementation(async (prefix) => {
      const createdRoot = await actualFs.mkdtemp(prefix);
      if (prefix === '/tmp/pg-') {
        root = createdRoot;
        roots.push(createdRoot);
      }
      return createdRoot;
    });
    vi.mocked(mkdir).mockImplementation(async (path, options) => {
      const candidate = String(path);
      if (root !== undefined && candidate.startsWith(`${root}/`)) {
        const operation = `mkdir:${candidate.slice(root.length + 1)}`;
        calls.push(operation);
        if (operation === 'mkdir:data') {
          entered.resolve();
          await gate.promise;
          throw primary;
        }
      }
      return actualFs.mkdir(path, options);
    });

    try {
      run = scenario.provisionAndReopen();
      await entered.promise;
      if (root === undefined) {
        throw new Error('PostgresScenario.fixture did not register its root');
      }
      cleaning = scenario.cleanup();
      const completedEarly = await Promise.race([
        cleaning.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
      ]);
      expect(completedEarly).toBe(false);
      await expect(actualFs.lstat(root)).resolves.toBeDefined();
      expect(calls).toEqual(['mkdir:data']);

      gate.reject(primary);
      gateReleased = true;
      await expect(run).rejects.toBe(primary);
      await expect(cleaning).resolves.toBeUndefined();
      expect(open).not.toHaveBeenCalled();
      await expect(actualFs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (!gateReleased) {
        gate.reject(primary);
      }
      await run?.catch(() => undefined);
      await cleaning?.catch(() => undefined);
      await scenario.cleanup().catch(() => undefined);
      open.mockRestore();
    }
  });

  it('does not erase an explicit close failure when final cleanup retries successfully', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const closeFailure = new Error('first explicit close failed');
    let closeCalls = 0;
    const held = createOwner(
      () => {
        closeCalls += 1;
        return closeCalls === 1 ? Promise.reject(closeFailure) : Promise.resolve();
      },
      async () => undefined,
    );
    await scope.acquire(async () => acquired(held), isOwner, isBusy);

    await expect(scope.requestOwnerClose(held)).rejects.toBe(closeFailure);
    const cleanupFailure = await lifetime.cleanup().catch((error: unknown) => error);
    expect(containsError(cleanupFailure, closeFailure)).toBe(true);
    expect(closeCalls).toBe(2);
    await expect(lstat(current.root)).resolves.toBeDefined();
  });

  it('keeps an unexpected close rejection sticky even when release is confirmed', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const closeFailure = new Error('unexpected close failure');
    const held = createOwner(
      () => Promise.reject(closeFailure),
      async () => undefined,
    );
    await scope.acquire(async () => acquired(held), isOwner, isBusy);

    await expect(lifetime.cleanup()).rejects.toThrow('unresolved roots retained');
    await expect(lstat(current.root)).resolves.toBeDefined();
  });

  it('reports both primary and cleanup failures', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const primary = new Error('primary error');
    const cleanupFailure = new Error('close error');
    const result = await scope
      .run(async () => {
        await scope.acquire(
          async () =>
            acquired(
              createOwner(
                () => Promise.reject(cleanupFailure),
                async () => undefined,
              ),
            ),
          isOwner,
          isBusy,
        );
        throw primary;
      })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    if (!(result instanceof AggregateError)) {
      throw new Error('scenario and cleanup failures were not aggregated');
    }
    expect(result.errors[0]).toBe(primary);
    expect(result.errors[1]).toBeInstanceOf(AggregateError);
    await expect(lstat(current.root)).resolves.toBeDefined();
  });

  it('closes a successor independently after the previous owner released', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    let previousCloseCalls = 0;
    let successorCloseCalls = 0;
    const previous = createOwner(
      async () => {
        previousCloseCalls += 1;
      },
      async () => undefined,
    );
    const successor = createOwner(
      async () => {
        successorCloseCalls += 1;
      },
      async () => undefined,
    );
    await scope.acquire(async () => acquired(previous), isOwner, isBusy);
    await scope.closeOwner(previous);
    await scope.acquire(async () => acquired(successor), isOwner, isBusy);

    await lifetime.cleanup();
    expect(previousCloseCalls).toBe(1);
    expect(successorCloseCalls).toBe(1);
    await expect(lstat(current.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('coalesces concurrent owner finalization and rejects a close after removal', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const close = deferred<void>();
    let closeCalls = 0;
    const held = createOwner(
      () => {
        closeCalls += 1;
        return close.promise;
      },
      async () => undefined,
    );
    await scope.acquire(async () => acquired(held), isOwner, isBusy);

    const first = scope.closeOwner(held);
    const concurrent = scope.closeOwner(held);
    expect(concurrent).toBe(first);
    close.resolve();
    await first;
    expect(closeCalls).toBe(1);
    expect(() => scope.requestOwnerClose(held)).toThrow('not registered');
    expect(closeCalls).toBe(1);

    await lifetime.cleanup();
    await expect(lstat(current.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an initial owner timeout in the current cleanup after late success', async () => {
    vi.useFakeTimers();
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const close = deferred<void>();
    const release = deferred<void>();
    const operation = deferred<void>();
    const acquiredOwner = deferred<void>();
    const closeEntered = deferred<void>();
    let closeCalls = 0;
    const held = createOwner(
      () => {
        closeCalls += 1;
        closeEntered.resolve();
        return close.promise;
      },
      () => release.promise,
    );
    const running = scope.run(async () => {
      await scope.acquire(async () => acquired(held), isOwner, isBusy);
      acquiredOwner.resolve();
      await operation.promise;
    });
    const runningOutcome = running.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await acquiredOwner.promise;

    const cleaning = lifetime.cleanup();
    const cleanupOutcome = cleaning.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await closeEntered.promise;
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(lstat(current.root)).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(1_000);
    close.resolve();
    release.resolve();
    operation.resolve();

    const [cleanupResult, runningResult] = await Promise.all([cleanupOutcome, runningOutcome]);
    expect(cleanupResult.kind).toBe('rejected');
    expect(runningResult.kind).toBe('rejected');
    if (cleanupResult.kind !== 'rejected' || runningResult.kind !== 'rejected') {
      throw new Error('the timed-out cleanup unexpectedly resolved');
    }
    expect(cleanupResult.error).toMatchObject({
      errors: [expect.objectContaining({ name: 'OwnerObservationTimeoutError' })],
    });
    expect(runningResult.error).toBe(cleanupResult.error);

    await expect(lifetime.cleanup()).resolves.toBeUndefined();
    expect(closeCalls).toBe(1);
    await expect(lstat(current.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a timeout from the second owner phase as a current-attempt failure', async () => {
    vi.useFakeTimers();
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const close = deferred<void>();
    const release = deferred<void>();
    const operation = deferred<void>();
    const closeEntered = deferred<void>();
    let closeCalls = 0;
    const held = createOwner(
      () => {
        closeCalls += 1;
        closeEntered.resolve();
        return close.promise;
      },
      () => release.promise,
    );
    await scope.acquire(async () => acquired(held), isOwner, isBusy);
    const trackedOperation = scope.observe(operation.promise);
    const trackedOutcome = trackedOperation.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    const cleaning = lifetime.cleanup();
    const cleanupOutcome = cleaning.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await closeEntered.promise;
    await vi.advanceTimersByTimeAsync(7_000);
    await vi.advanceTimersByTimeAsync(7_000);
    await vi.advanceTimersByTimeAsync(7_000);
    const firstAttempt = await cleanupOutcome;
    expect(firstAttempt.kind).toBe('rejected');
    if (firstAttempt.kind !== 'rejected') {
      throw new Error('the second owner timeout was not reported');
    }
    expect(countNamedErrors(firstAttempt.error, 'OwnerObservationTimeoutError')).toBe(2);
    await expect(lstat(current.root)).resolves.toBeDefined();

    close.resolve();
    release.resolve();
    operation.resolve();
    expect((await trackedOutcome).kind).toBe('resolved');
    await expect(lifetime.cleanup()).resolves.toBeUndefined();
    expect(closeCalls).toBe(1);
    await expect(lstat(current.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('coalesces concurrent cleanup and attempts every owner despite one failure', async () => {
    const lifetime = new ProvisionFixtureLifetime();
    const scope = lifetime.scope();
    const current = await fixture(scope);
    const entered = deferred<void>();
    const finish = deferred<void>();
    let failedCloseCalls = 0;
    let healthyCloseCalls = 0;
    const failed = createOwner(
      async () => {
        failedCloseCalls += 1;
        throw new Error('expected synthetic close failure');
      },
      async () => undefined,
    );
    const healthy = createOwner(
      async () => {
        healthyCloseCalls += 1;
        entered.resolve();
        await finish.promise;
      },
      async () => undefined,
    );
    await scope.acquire(async () => acquired(failed), isOwner, isBusy);
    await scope.acquire(async () => acquired(healthy), isOwner, isBusy);

    const cleaning = lifetime.cleanup();
    expect(lifetime.cleanup()).toBe(cleaning);
    await entered.promise;
    finish.resolve();
    await expect(cleaning).rejects.toThrow('unresolved roots retained');
    expect(failedCloseCalls).toBe(1);
    expect(healthyCloseCalls).toBe(1);
    await expect(lstat(current.root)).resolves.toBeDefined();
  });

  it('stops a child whose owned handle arrives after exit was requested', async () => {
    const child = new FailingCancellationProcess();
    const stop = vi.spyOn(child, 'stop');
    const cancellation = new AbortController();
    const request: ManagedProcessRequest = {
      args: [],
      cancellation: { graceMs: 0, killWaitMs: 5_000, signal: cancellation.signal },
      cwd: tmpdir(),
      env: { PATH: globalThis.process.env.PATH ?? '' },
      executable: globalThis.process.execPath,
      stdio: { stderr: 'ignore', stdin: 'ignore', stdout: 'ignore' },
    };
    try {
      const starting = child.start(request);
      const firstExit = child.exit();
      const secondExit = child.exit();
      expect(secondExit).toBe(firstExit);
      const handle = await starting;
      await Promise.all([firstExit, secondExit]);
      expect(stop).toHaveBeenCalledTimes(1);
      cancellation.abort();

      const completion = await handle.completion;
      expect(completion.exitCode).toBeNull();
      expect(['SIGTERM', 'SIGKILL']).toContain(completion.signal);
    } finally {
      cancellation.abort();
      await child.exit().catch(() => undefined);
      stop.mockRestore();
    }
  });
});
