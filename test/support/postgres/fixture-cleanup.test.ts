import { lstat, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { LoopbackPortAllocator } from '../../../src/postgres/loopback-port-allocator.js';
import type { PublishedControl } from '../../../src/processes/control-discovery.types.js';
import { ManagedProcessService } from '../../../src/processes/managed-process.service.js';
import type {
  OwnedProcess,
  ProcessCompletion,
} from '../../../src/processes/managed-process.types.js';
import type { ManagedProcessRequest } from '../../../src/processes/managed-process.types.js';
import { PublishedControlService } from '../../../src/processes/published-control.service.js';
import { ExternalPostgresLifecycleScenario } from './external-postgres-lifecycle-scenario.js';
import {
  cleanupRegistered,
  closeFixtureOwner,
  FixtureCleanupTimeoutError,
  observeFixtureCleanup,
} from './fixture-cleanup.js';
import { PostgresLifecycleScenario } from './postgres-lifecycle-scenario.js';
import { ClusterFixture, PostgresReadinessScenario } from './postgres-readiness-scenario.js';
import { TrackedPostgresProcesses } from './tracked-postgres-processes.js';

vi.mock('../../../src/postgres/embedded-postgres-binaries.js', () => ({
  loadEmbeddedPostgresBinaries: () =>
    Promise.resolve({ initdb: '/fixture/initdb', postgres: '/fixture/postgres' }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const success: ProcessCompletion = { exitCode: 0, signal: null };

function lifecycleOwner(
  close: () => Promise<void>,
  ownershipReleased: () => Promise<void>,
): Extract<PublishedControl, { kind: 'held' }> {
  return {
    kind: 'held',
    databaseKind: 'embedded',
    canonicalDataDir: '/fixture/data',
    endpoint: '/fixture/control.sock',
    stopResult: Promise.resolve({ kind: 'not-requested' }),
    stopDelivery: Promise.resolve({ kind: 'failed' }),
    startDatabase: async () => {
      throw new Error('controlled cancelled start');
    },
    close,
    ownershipReleased,
  };
}

describe('PostgreSQL fixture safety without real children', () => {
  const roots: string[] = [];
  let startProcess: MockInstance<ManagedProcessService['start']>;
  let stopProcess: MockInstance<ManagedProcessService['stop']>;
  let isAlive: MockInstance<ClusterFixture['isAlive']>;

  beforeEach(() => {
    isAlive = vi.spyOn(ClusterFixture.prototype, 'isAlive').mockResolvedValue(true);
    // Every test must explicitly provide fake handles; accidental real spawn fails.
    startProcess = vi
      .spyOn(ManagedProcessService.prototype, 'start')
      .mockRejectedValue(new Error('unexpected fixture spawn'));
    stopProcess = vi
      .spyOn(ManagedProcessService.prototype, 'stop')
      .mockRejectedValue(new Error('unexpected fixture stop'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // These tests never start OS processes, including retained-handle cases.
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('creates and closes an unstarted fixture without acquiring resources', async () => {
    const fixture = ClusterFixture.create('scram', 15432);
    const closing = fixture.close();
    expect(fixture.close()).toBe(closing);
    await closing;
    await expect(fixture.start()).rejects.toThrow('fixture is closing');
    expect(startProcess).not.toHaveBeenCalled();
  });

  it('retains the original start failure after confirmed cleanup', async () => {
    const primary = new Error('spawn failed');
    startProcess.mockRejectedValue(primary);
    const fixture = ClusterFixture.create('scram', 15432);
    await expect(fixture.start()).rejects.toBe(primary);
    await expect(lstat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' });
    await fixture.close();
  });

  it('coalesces close, preserves stop policy, and removes root only after completion', async () => {
    const completion = deferred<ProcessCompletion>();
    const stopEntered = deferred<void>();
    const postgres: OwnedProcess = { completion: completion.promise };
    startProcess
      .mockResolvedValueOnce({ completion: Promise.resolve(success) })
      .mockResolvedValueOnce(postgres);
    stopProcess.mockImplementation(async () => {
      stopEntered.resolve();
      await completion.promise;
    });
    const fixture = ClusterFixture.create('scram', 15432);
    await fixture.start();
    roots.push(fixture.root);
    const closing = fixture.close();
    expect(fixture.close()).toBe(closing);
    await stopEntered.promise;
    expect((await lstat(fixture.root)).isDirectory()).toBe(true);
    completion.resolve(success);
    await closing;
    expect(stopProcess).toHaveBeenCalledExactlyOnceWith(postgres, {
      graceMs: 1000,
      killWaitMs: 5000,
    });
    await expect(lstat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not await a never-settling completion after failed-start stop rejection', async () => {
    const stopFailure = new Error('stop rejected');
    const pending = deferred<ProcessCompletion>();
    startProcess
      .mockResolvedValueOnce({ completion: Promise.resolve(success) })
      .mockResolvedValueOnce({ completion: pending.promise });
    stopProcess.mockRejectedValue(stopFailure);
    const primary = new Error('readiness failed');
    isAlive.mockImplementation(() => {
      throw primary;
    });
    const fixture = ClusterFixture.create('scram', 15432);
    const failure = await fixture.start().catch((error: unknown) => error);
    roots.push(fixture.root);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ errors: [primary, expect.any(AggregateError)] });
    expect((await lstat(fixture.root)).isDirectory()).toBe(true);
    await expect(fixture.close()).rejects.toBeInstanceOf(AggregateError);
    expect(stopProcess).toHaveBeenCalledTimes(1);
    pending.resolve(success);
  });

  it('interrupts initdb and never starts postgres when close races startup', async () => {
    const initdbStarted = deferred<void>();
    const completion = deferred<ProcessCompletion>();
    const initdb: OwnedProcess = { completion: completion.promise };
    startProcess.mockImplementation(async () => {
      initdbStarted.resolve();
      return initdb;
    });
    stopProcess.mockImplementation(() => {
      completion.resolve(success);
      return Promise.resolve();
    });
    const fixture = ClusterFixture.create('scram', 15432);
    const starting = fixture.start().catch((error: unknown) => error);
    await initdbStarted.promise;
    await fixture.close();
    expect(await starting).toBeInstanceOf(Error);
    expect(startProcess).toHaveBeenCalledTimes(1);
    await expect(lstat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('owns and stops a handle returned after close has begun', async () => {
    const entered = deferred<void>();
    const late = deferred<OwnedProcess>();
    const completion = deferred<ProcessCompletion>();
    const child: OwnedProcess = { completion: completion.promise };
    startProcess.mockImplementation(() => {
      entered.resolve();
      return late.promise;
    });
    stopProcess.mockImplementation(() => {
      completion.resolve(success);
      return Promise.resolve();
    });
    const fixture = ClusterFixture.create('scram', 15432);
    const starting = fixture.start().catch((error: unknown) => error);
    await entered.promise;
    const closing = fixture.close();
    late.resolve(child);
    await closing;
    expect(await starting).toBeInstanceOf(Error);
    expect(startProcess).toHaveBeenCalledTimes(1);
    expect(stopProcess).toHaveBeenCalledExactlyOnceWith(child, {
      graceMs: 1000,
      killWaitMs: 5000,
    });
    await expect(lstat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds cleanup observation without claiming a pending operation completed', async () => {
    vi.useFakeTimers();
    const operation = deferred<void>();
    const outcome = observeFixtureCleanup(operation.promise).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await outcome).toMatchObject({ message: 'Fixture cleanup remains unconfirmed' });
    operation.reject(new Error('late rejection is observed'));
    await Promise.resolve();
  });

  it('supports a lifecycle cleanup observation bound without changing the default', async () => {
    vi.useFakeTimers();
    const operation = deferred<void>();
    let settled = false;
    const outcome = observeFixtureCleanup(operation.promise, 30_000).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeInstanceOf(FixtureCleanupTimeoutError);
    operation.reject(new Error('late operation rejection is observed'));
    await Promise.resolve();
  });

  it('drains a process handle returned after shutdown starts and blocks later starts', async () => {
    const starting = deferred<OwnedProcess>();
    const completion = deferred<ProcessCompletion>();
    const process: OwnedProcess = { completion: completion.promise };
    startProcess.mockReturnValue(starting.promise);
    const processes = new TrackedPostgresProcesses();
    const request: ManagedProcessRequest = {
      args: ['-D', '/fixture/data'],
      cwd: '/fixture',
      env: {},
      executable: '/fixture/postgres',
      stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    };
    const opening = processes.start(request);
    let drained = false;
    const draining = processes.drain().then(() => {
      drained = true;
    });
    await expect(processes.start(request)).rejects.toThrow('fixture is closing');
    starting.resolve(process);
    await opening;
    await Promise.resolve();
    expect(drained).toBe(false);
    completion.resolve(success);
    await draining;
    expect(drained).toBe(true);
    expect(processes.completedPostgres).toBe(1);
  });

  it('retains the root when an owned stop hangs beyond the observation bound', async () => {
    const completion = deferred<ProcessCompletion>();
    const stopping = deferred<void>();
    startProcess
      .mockResolvedValueOnce({ completion: Promise.resolve(success) })
      .mockResolvedValueOnce({ completion: completion.promise });
    stopProcess.mockReturnValue(stopping.promise);
    const fixture = ClusterFixture.create('scram', 15432);
    await fixture.start();
    roots.push(fixture.root);
    vi.useFakeTimers();
    const closing = fixture.close().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await closing).toBeInstanceOf(AggregateError);
    expect((await lstat(fixture.root)).isDirectory()).toBe(true);
    stopping.resolve();
    completion.resolve(success);
    await Promise.resolve();
    expect((await lstat(fixture.root)).isDirectory()).toBe(true);
  });

  it('releases a late port reservation without spawning postgres after close', async () => {
    const entered = deferred<void>();
    const reservation = deferred<Awaited<ReturnType<LoopbackPortAllocator['reserve']>>>();
    const release = vi.fn<() => Promise<void>>(() => Promise.resolve());
    vi.spyOn(LoopbackPortAllocator.prototype, 'reserve').mockImplementation(() => {
      entered.resolve();
      return reservation.promise;
    });
    startProcess.mockResolvedValueOnce({
      completion: Promise.resolve(success),
    });
    const fixture = ClusterFixture.create('scram');
    const starting = fixture.start().catch((error: unknown) => error);
    await entered.promise;
    const closing = fixture.close();
    reservation.resolve({ port: 15432, release });
    await closing;
    expect(await starting).toBeInstanceOf(Error);
    expect(release).toHaveBeenCalledTimes(1);
    expect(startProcess).toHaveBeenCalledTimes(1);
    await expect(lstat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps failed registry entries while attempting all independent cleanup operations', async () => {
    const entries = ['failed', 'ok'];
    const primary = new Error('cleanup failure');
    const closed: string[] = [];
    const failure = await cleanupRegistered(entries, (entry) => {
      closed.push(entry);
      return entry === 'failed' ? Promise.reject(primary) : Promise.resolve();
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ errors: [primary] });
    expect(entries).toEqual(['failed']);
    expect(closed).toEqual(['failed', 'ok']);
  });

  it('accepts only a classified close rejection after independent release confirmation', async () => {
    const expected = new Error('expected close rejection');
    const release = deferred<void>();
    const releaseObserved = deferred<void>();
    const owner = {
      close: () => Promise.reject(expected),
      ownershipReleased: () => {
        releaseObserved.resolve();
        return release.promise;
      },
    };
    const entries = [owner];
    const cleanup = cleanupRegistered(entries, (entry) =>
      closeFixtureOwner(entry, (error) => error === expected),
    );
    await releaseObserved.promise;
    expect(entries).toEqual([owner]);
    release.resolve();
    await cleanup;
    expect(entries).toEqual([]);
  });

  it('does not suppress an unexpected close rejection even after release is confirmed', async () => {
    const unexpected = new Error('unexpected close failure');
    const released = vi.fn<() => Promise<void>>(() => Promise.resolve());
    await expect(
      closeFixtureOwner({
        close: () => Promise.reject(unexpected),
        ownershipReleased: released,
      }),
    ).rejects.toMatchObject({
      message: 'Fixture owner close failed after confirmed release',
      errors: [unexpected],
    });
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('retains the owner when expected close rejection is followed by unconfirmed release', async () => {
    vi.useFakeTimers();
    const expected = new Error('expected close rejection');
    const release = deferred<void>();
    const owner = {
      close: () => Promise.reject(expected),
      ownershipReleased: () => release.promise,
    };
    const entries = [owner];
    const cleanup = cleanupRegistered(entries, (entry) =>
      closeFixtureOwner(entry, (error) => error === expected),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await cleanup).toMatchObject({
      errors: [
        expect.objectContaining({
          message: 'Fixture owner release remains unconfirmed',
          errors: [expected, expect.any(Error)],
        }),
      ],
    });
    expect(entries).toEqual([owner]);
    release.resolve();
    await Promise.resolve();
    expect(entries).toEqual([owner]);
  });

  it('preserves both errors when close and ownership release reject', async () => {
    const closeError = new Error('expected close rejection');
    const releaseError = new Error('ownership release failed');
    await expect(
      closeFixtureOwner(
        {
          close: () => Promise.reject(closeError),
          ownershipReleased: () => Promise.reject(releaseError),
        },
        (error) => error === closeError,
      ),
    ).rejects.toMatchObject({
      message: 'Fixture owner release remains unconfirmed',
      errors: [closeError, releaseError],
    });
  });

  it('retains lifecycle roots and reports owner cleanup failures', async () => {
    const closeFailure = new Error('controlled owner close failure');
    const releaseFailure = new Error('controlled owner release failure');
    const owner = lifecycleOwner(
      () => Promise.reject(closeFailure),
      () => Promise.reject(releaseFailure),
    );
    const opened = vi.spyOn(PublishedControlService.prototype, 'open').mockResolvedValue(owner);
    const scenario = new PostgresLifecycleScenario();
    await expect(scenario.rejectsAnAlreadyCancelledStart()).rejects.toBe(closeFailure);
    const request = opened.mock.calls[0]?.[0];
    if (!request) {
      throw new Error('lifecycle owner request was not observed');
    }
    const root = dirname(request.dataDir);
    roots.push(root);

    const cleanupFailure = await scenario.cleanup().catch((error: unknown) => error);
    expect(cleanupFailure).toBeInstanceOf(AggregateError);
    expect(cleanupFailure).toMatchObject({ errors: [closeFailure, releaseFailure] });
    expect((await lstat(root)).isDirectory()).toBe(true);
  });

  it('waits for a late lifecycle owner to close before removing its root', async () => {
    const entered = deferred<string>();
    const acquisition = deferred<PublishedControl>();
    const closeEntered = deferred<void>();
    const released = deferred<void>();
    const owner = lifecycleOwner(
      () => {
        closeEntered.resolve();
        return released.promise;
      },
      () => released.promise,
    );
    vi.spyOn(PublishedControlService.prototype, 'open').mockImplementation((request) => {
      entered.resolve(dirname(request.dataDir));
      return acquisition.promise;
    });
    const scenario = new PostgresLifecycleScenario();
    const running = scenario.rejectsAnAlreadyCancelledStart().catch((error: unknown) => error);
    const root = await entered.promise;
    roots.push(root);
    const cleanup = scenario.cleanup();
    acquisition.resolve(owner);
    await closeEntered.promise;

    expect((await lstat(root)).isDirectory()).toBe(true);
    released.resolve();
    await cleanup;
    expect(await running).toBeInstanceOf(Error);
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps external roots when a pending owner acquisition rejects during cleanup', async () => {
    const entered = deferred<string>();
    const acquisition = deferred<never>();
    vi.spyOn(PublishedControlService.prototype, 'open').mockImplementation((request) => {
      entered.resolve(dirname(request.dataDir));
      return acquisition.promise;
    });
    const scenario = new ExternalPostgresLifecycleScenario();
    const running = scenario.rejectsAnExplicitEmptyUrlWithoutSelectingEmbedded();
    const root = await entered.promise;
    roots.push(root);
    const cleanup = scenario.cleanup().catch((error: unknown) => error);
    acquisition.reject(new Error('controlled acquisition failure'));
    await running;
    expect(await cleanup).toBeInstanceOf(AggregateError);
    expect((await lstat(root)).isDirectory()).toBe(true);
    await expect(scenario.cleanup()).rejects.toBeInstanceOf(AggregateError);
    expect((await lstat(root)).isDirectory()).toBe(true);
  });

  it.each(['readiness', 'external'] as const)(
    'rejects a new %s startup after cleanup without creating a fixture',
    async (kind) => {
      const create = vi.spyOn(ClusterFixture, 'create');
      const scenario =
        kind === 'readiness'
          ? new PostgresReadinessScenario()
          : new ExternalPostgresLifecycleScenario();
      await scenario.cleanup();
      const running =
        scenario instanceof PostgresReadinessScenario
          ? scenario.initializesTheOwnedDatabase()
          : scenario.connectsToTheSelectedDatabaseWithoutOwningTheServer();
      await expect(running).rejects.toThrow('scenario is closing');
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each(['readiness', 'external'] as const)(
    'registers the %s fixture before startup resolves and preserves cleanup failure',
    async (kind) => {
      const entered = deferred<void>();
      const start = deferred<void>();
      const cleanupFailure = new Error('retained fixture');
      vi.spyOn(ClusterFixture.prototype, 'start').mockImplementation(() => {
        entered.resolve();
        return start.promise;
      });
      const close = vi.spyOn(ClusterFixture.prototype, 'close').mockRejectedValue(cleanupFailure);
      const scenario =
        kind === 'readiness'
          ? new PostgresReadinessScenario()
          : new ExternalPostgresLifecycleScenario();
      const running = (
        scenario instanceof PostgresReadinessScenario
          ? scenario.initializesTheOwnedDatabase()
          : scenario.connectsToTheSelectedDatabaseWithoutOwningTheServer()
      ).catch((error: unknown) => error);
      await entered.promise;
      await expect(scenario.cleanup()).rejects.toBeInstanceOf(AggregateError);
      await expect(scenario.cleanup()).rejects.toBeInstanceOf(AggregateError);
      expect(close).toHaveBeenCalledTimes(2);
      start.reject(new Error('controlled startup rejected'));
      expect(await running).toMatchObject({ message: 'controlled startup rejected' });
    },
  );
});
