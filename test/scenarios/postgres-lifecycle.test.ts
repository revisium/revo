import { afterEach, describe, expect, it } from 'vitest';

import { PostgresLifecycleScenario } from '../support/postgres/postgres-lifecycle-scenario.js';

describe('embedded PostgreSQL owned lifecycle', () => {
  let scenario = new PostgresLifecycleScenario();
  afterEach(async () => {
    await scenario.cleanup();
    scenario = new PostgresLifecycleScenario();
  });

  it('starts once and preserves committed data and credentials across restart', async () => {
    const result = await scenario.persistsAcrossOwnedRestart();
    expect(result.first).toMatchObject({ kind: 'embedded', database: 'revo' });
    expect(result.coalesced).toEqual(result.first);
    expect(result.second).toMatchObject({ kind: 'embedded', database: 'revo' });
    expect(result.rows).toEqual([{ value: 'survives restart' }]);
    expect(result.passwordLength).toBe(32);
  });

  it('does not prepare or spawn for an already-cancelled request', async () => {
    await expect(scenario.rejectsAnAlreadyCancelledStart()).resolves.toBe('rejected');
  });

  it('retries confirmed bind exits and leaves every foreign listener alive', async () => {
    await expect(scenario.retriesOnlyThreeConfirmedBindConflicts(2)).resolves.toMatchObject({
      outcome: { kind: 'ready' },
      ports: 3,
      distinct: true,
      previousExited: true,
      listeners: ['foreign-listener', 'foreign-listener'],
    });
  });

  it('exhausts exactly three confirmed bind exits without touching foreign listeners', async () => {
    await expect(scenario.retriesOnlyThreeConfirmedBindConflicts(3)).resolves.toEqual({
      outcome: { kind: 'rejected' },
      ports: 3,
      distinct: true,
      previousExited: true,
      listeners: ['foreign-listener', 'foreign-listener', 'foreign-listener'],
    });
  });

  it('does not respawn after a real authentication failure', async () => {
    await expect(scenario.doesNotRespawnAfterAuthenticationFailure()).resolves.toEqual({
      outcome: 'rejected',
      postgresStarts: 1,
    });
  });

  it('does not mistake an independent trust server for its owned database', async () => {
    await expect(scenario.rejectsARealTrustServerWithTheWrongNonce()).resolves.toEqual({
      outcome: expect.objectContaining({ kind: 'ready' }),
      postgresStarts: 2,
      ownedPortDiffers: true,
      reachable: true,
      databaseCreated: false,
    });
  }, 10_000);

  it('retains ownership after stop failure until the real owned server exits', async () => {
    await expect(
      scenario.retainsOwnershipAfterStopFailureUntilTheOwnedServerActuallyExits(),
    ).resolves.toEqual({
      closeOutcome: {
        kind: 'failed',
        ownership: 'retained',
        error: { code: 'CONTROL_STOP_FAILED', message: 'Control stop callback failed' },
      },
      repeatedClose: 'rejected',
      busy: 'busy',
      beforeJournalDrain: 'busy',
      reopened: 'held',
      endpointRetry: 'rejected',
      completion: { exitCode: 0, signal: null },
    });
  }, 45_000);

  it('cancels an actually spawned owned server before readiness completes', async () => {
    await expect(
      scenario.cancelsAnActuallySpawnedServerBeforeReadinessCompletes(),
    ).resolves.toEqual({
      outcome: 'rejected',
      completion: { exitCode: null, signal: 'SIGTERM' },
    });
  });

  it('does not spawn PostgreSQL when cancellation lands during reservation release', async () => {
    await expect(scenario.abortsAfterReservationReleaseWithoutSpawningPostgres()).resolves.toEqual({
      outcome: 'rejected',
      postgresStarts: 0,
    });
  });

  it('does not publish a dead child after an accepted ready journal write', async () => {
    await expect(scenario.rejectsWhenTheReadyChildExitsDuringAcceptedCompletion()).resolves.toEqual(
      {
        outcome: 'rejected',
        closeOutcome: 'rejected',
        completion: { exitCode: 0, signal: null },
      },
    );
  }, 10_000);

  it('rejects a child that exits while the completion write is accepted without cancellation', async () => {
    await expect(
      scenario.rejectsWhenTheReadyChildExitsDuringAcceptedCompletion(false),
    ).resolves.toEqual({
      outcome: 'rejected',
      closeOutcome: 'not-requested',
      completion: { exitCode: 0, signal: null },
    });
  }, 10_000);

  it('does not spawn again after startup and owned stop both fail', async () => {
    await expect(
      scenario.rejectsRestartAfterFailedStartupStopUntilTheChildExits(),
    ).resolves.toEqual({
      first: 'rejected',
      repeated: 'rejected',
      startsBeforeExit: 1,
      busy: 'busy',
    });
  });
});
