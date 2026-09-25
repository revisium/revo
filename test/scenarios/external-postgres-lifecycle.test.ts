import { afterEach, describe, expect, it } from 'vitest';

import {
  ExternalPostgresLifecycleScenario,
  REAL_PG_CLEANUP_TIMEOUT_MS,
} from '../support/postgres/external-postgres-lifecycle-scenario.js';
import { REAL_PG_SCENARIO_TIMEOUT_MS } from '../support/postgres/postgres-readiness-scenario.js';

describe('external PostgreSQL owned client lifecycle', () => {
  let scenario = new ExternalPostgresLifecycleScenario();
  afterEach(async () => {
    await scenario.cleanup();
    scenario = new ExternalPostgresLifecycleScenario();
  }, REAL_PG_CLEANUP_TIMEOUT_MS);

  it(
    'selects the configured database without preparing, creating, or owning PostgreSQL',
    async () => {
      await expect(scenario.connectsToTheSelectedDatabaseWithoutOwningTheServer()).resolves.toEqual(
        {
          results: [{ kind: 'external' }, { kind: 'external' }],
          samePromise: true,
          activeDatabases: ['external_target'],
          embeddedPreparationExposed: false,
          revoDatabaseCreated: false,
          serverAlive: true,
        },
      );
    },
    REAL_PG_SCENARIO_TIMEOUT_MS,
  );

  it(
    'requires verified TLS by default and permits an explicit plaintext connection',
    async () => {
      const result = await scenario.rejectsPlainPostgresByDefaultButAllowsExplicitDisable();
      expect(result).toEqual({
        rejected: {
          name: 'ExternalPostgresError',
          message: 'External PostgreSQL lifecycle failed',
          code: 'revo.postgres.external.lifecycle',
        },
        accepted: { kind: 'external' },
        serverAlive: true,
      });
    },
    REAL_PG_SCENARIO_TIMEOUT_MS,
  );

  it('rejects an explicitly empty URL instead of selecting embedded PostgreSQL', async () => {
    await expect(scenario.rejectsAnExplicitEmptyUrlWithoutSelectingEmbedded()).resolves.toEqual({
      name: 'PublishedControlError',
      message: 'Published control lifecycle failed',
    });
  });

  it(
    'settles early cancellation and connection failure with safe bounded errors',
    async () => {
      const result = await scenario.cancellationAndConnectionFailureAreSafeAndBounded();
      expect(result.cancelled).toMatchObject({ code: 'revo.postgres.external.lifecycle' });
      expect(result.failed).toMatchObject({ code: 'revo.postgres.external.lifecycle' });
      expect(result.cancelledMs).toBeLessThan(1500);
      expect(result.failedMs).toBeLessThan(1500);
      expect(result.serverAlive).toBe(true);
    },
    REAL_PG_SCENARIO_TIMEOUT_MS,
  );

  it(
    'cannot publish ready after timeout, close, or transport failure during accepted writes',
    async () => {
      const result =
        await scenario.rejectsTimeoutAbortAndTransportFailureAcrossAcceptedJournalWrites();
      expect(result.timeout).toMatchObject({ code: 'revo.postgres.external.lifecycle' });
      expect(result.deadlineAfterSql).toMatchObject({
        code: 'revo.postgres.external.lifecycle',
      });
      expect(result.abort).toMatchObject({ code: 'revo.postgres.external.lifecycle' });
      expect(result.transport).toMatchObject({ code: 'revo.postgres.external.lifecycle' });
      expect(result.transportClose).toEqual({
        kind: 'rejected',
        name: 'PublishedControlError',
        message: 'Published control lifecycle failed',
        code: 'PUBLISHED_CONTROL_ERROR',
      });
      expect(result.transportReopened).toBe('held');
      expect(result.serverAlive).toBe(true);
    },
    REAL_PG_SCENARIO_TIMEOUT_MS,
  );

  it('keeps the owner busy after bounded close failure until public client end settles', async () => {
    await expect(scenario.retainsOwnershipUntilDelayedPublicClientEndSettles()).resolves.toEqual({
      endThenJournal: {
        closeOutcome: 'rejected',
        busy: 'busy',
        afterFirstDrain: 'busy',
        reopened: 'held',
        queries: ['SELECT 1'],
      },
      journalThenEnd: {
        closeOutcome: 'rejected',
        busy: 'busy',
        afterFirstDrain: 'busy',
        reopened: 'held',
        queries: ['SELECT 1'],
      },
    });
  });

  it('aborts a real stalled connection without stopping its foreign listener', async () => {
    const result = await scenario.abortsARealStalledConnectionWithoutStoppingTheForeignListener();
    expect(result.outcome).toMatchObject({ code: 'revo.postgres.external.lifecycle' });
    expect(result.elapsedMs).toBeLessThan(1500);
    expect(result.listenerAlive).toBe(true);
  });

  it(
    'isolates a real child connection from hostile PostgreSQL environment defaults',
    async () => {
      await expect(scenario.isolatesHostilePostgresEnvironmentInARealChild()).resolves.toEqual({
        explicit: { kind: 'ready', database: 'postgres' },
        missingPassword: { kind: 'failed', name: expect.any(String) },
      });
    },
    REAL_PG_SCENARIO_TIMEOUT_MS,
  );
});
