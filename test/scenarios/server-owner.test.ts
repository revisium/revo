import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ServerOwnerScenario } from '../support/server/server-owner-scenario.js';

const REAL_OWNER_START_TIMEOUT_MS = 125_000;
const REAL_OWNER_RESTART_TIMEOUT_MS = 255_000;
const REAL_OWNER_CONTROL_STOP_TIMEOUT_MS = 145_000;
const REAL_OWNER_CLEANUP_TIMEOUT_MS = 20_000;

describe('Server owner composition', () => {
  let scenario: ServerOwnerScenario;

  beforeEach(async () => {
    scenario = await new ServerOwnerScenario().setup();
  });

  afterEach(async () => {
    await scenario.cleanup();
  }, REAL_OWNER_CLEANUP_TIMEOUT_MS);

  it('resolves the server owner through its Nest module', async () => {
    await expect(scenario.resolvesServerOwnerThroughNest()).resolves.toBe(true);
  });

  it(
    'starts real embedded PostgreSQL and Core before publishing readiness',
    async () => {
      const result = await scenario.startsEmbedded();

      expect(result.ready).toEqual({ kind: 'ready', url: 'http://127.0.0.1:3210' });
      expect(
        result.events
          .filter((event) =>
            [
              'application-database-migrations',
              'dbos-system-migrations',
              'application-bootstrap',
              'api-readiness',
            ].includes(event.phase),
          )
          .map((event) => `${event.phase}:${event.status}`),
      ).toEqual([
        'application-database-migrations:started',
        'application-database-migrations:completed',
        'dbos-system-migrations:started',
        'dbos-system-migrations:completed',
        'application-bootstrap:started',
        'application-bootstrap:completed',
        'api-readiness:started',
        'api-readiness:completed',
      ]);
      expect(result.events.at(-1)).toMatchObject({ phase: 'server-start', status: 'ready' });
    },
    REAL_OWNER_START_TIMEOUT_MS,
  );

  it(
    'restarts against the existing embedded database',
    async () => {
      await expect(scenario.restartsExistingData()).resolves.toMatchObject({
        ready: { kind: 'ready' },
        owners: 2,
      });
    },
    REAL_OWNER_RESTART_TIMEOUT_MS,
  );

  it(
    'finishes Core and database ownership after a published control stop',
    async () => {
      await expect(scenario.stopsThroughPublishedControl()).resolves.toEqual({
        outcome: { kind: 'stopped' },
        replacement: 'held',
      });
    },
    REAL_OWNER_CONTROL_STOP_TIMEOUT_MS,
  );

  it('retains the lease after Core exits until blocked journal work drains', async () => {
    await expect(scenario.holdsLeaseUntilBlockedJournalDrains()).resolves.toEqual({
      contender: 'busy',
      coreCompleted: true,
    });
  });

  it('retains one Core and the lease after failed stop, then retries finalization', async () => {
    await expect(scenario.retainsLeaseAfterFailedCoreStop()).resolves.toEqual({
      first: 'rejected',
      contender: 'busy',
      replacement: 'held',
      starts: 1,
      outcome: {
        kind: 'failed',
        code: 'revo.server-owner.stop',
        cleanup: 'retained',
      },
    });
  });

  it('observes a natural Core exit and releases ownership after ordered cleanup', async () => {
    await expect(scenario.cleansAfterNaturalCoreExit()).resolves.toEqual({
      outcome: {
        kind: 'failed',
        code: 'revo.server-owner.core',
        cleanup: 'completed',
      },
      replacement: 'held',
    });
  });

  it('retains a real held lease after close failure and retries the same owner', async () => {
    await expect(scenario.retriesFailedHeldCleanup()).resolves.toEqual({
      first: 'retained',
      outcome: {
        kind: 'failed',
        code: 'revo.server-owner.stop',
        cleanup: 'retained',
      },
      contender: 'busy',
      replacement: 'held',
    });
  });

  it('latches a stop accepted before owner assignment and never starts Core', async () => {
    await expect(scenario.latchesStopBeforeOwnerAssignment()).resolves.toEqual({
      startResult: 'stopped',
      replacement: 'held',
      starts: 0,
    });
  });

  it('releases the real held lease when database startup fails before Core opens', async () => {
    await expect(scenario.cleansLeaseWhenDatabaseStartFails()).resolves.toEqual({
      startResult: 'revo.server-owner.database',
      outcome: {
        kind: 'failed',
        code: 'revo.server-owner.database',
        cleanup: 'completed',
      },
      replacement: 'held',
      starts: 0,
    });
  });

  it('does not persist readiness when cancellation wins before the rename fence', async () => {
    await expect(scenario.cancelsBeforeReadyCommit()).resolves.toEqual({
      startResult: 'failed',
      contender: 'busy',
      coreCompleted: true,
      readyRecords: 0,
    });
  });

  it('keeps one historical ready record but rejects startup after rename-fence cancellation', async () => {
    await expect(scenario.cancelsAfterReadyCommitFence()).resolves.toEqual({
      startResult: 'failed',
      readyRecords: 1,
    });
  });
});
