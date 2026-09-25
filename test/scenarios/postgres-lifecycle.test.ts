import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PostgresLifecycleScenario } from '../support/postgres/postgres-lifecycle-scenario.js';
import { PostgresLifecycleTestScope } from '../support/postgres/postgres-lifecycle-test-scope.js';

describe('embedded PostgreSQL owned lifecycle', () => {
  const scope = new PostgresLifecycleTestScope();
  let scenario: PostgresLifecycleScenario;
  let scenarioStartedForTest = false;
  beforeEach(() => {
    scenarioStartedForTest = false;
    scenario = scope.begin();
    scenarioStartedForTest = true;
  });
  afterEach(async () => {
    if (!scenarioStartedForTest) {
      return;
    }
    scenarioStartedForTest = false;
    await scope.cleanup();
  }, 35_000);

  it('starts once and preserves committed data and credentials across restart', async () => {
    const result = await scenario.persistsAcrossOwnedRestart();
    expect(result.first).toMatchObject({ kind: 'embedded', database: 'revo' });
    expect(result.coalesced).toEqual(result.first);
    expect(result.second).toMatchObject({ kind: 'embedded', database: 'revo' });
    expect(result.rows).toEqual([{ value: 'survives restart' }]);
    expect(result.passwordPreserved).toBe(true);
    expect(result.passwordLength).toBe(32);
    expect(result.completedBeforeRelease).toBe(0);
    expect(result.firstCompletion).toEqual({ exitCode: 0, signal: null });
    expect(result.secondCompletion).toEqual({ exitCode: 0, signal: null });
    expect(result.firstCancellationPolicies).toEqual([{ graceMs: 20_000, killWaitMs: 5000 }]);
    expect(result.firstStopPolicies).toEqual([
      { graceMs: 20_000, killWaitMs: 5000, escalationSignal: 'SIGINT' },
    ]);
    expect(result.secondCancellationPolicies).toEqual([{ graceMs: 20_000, killWaitMs: 5000 }]);
    expect(result.secondStopPolicies).toEqual([
      { graceMs: 20_000, killWaitMs: 5000, escalationSignal: 'SIGINT' },
    ]);
  }, 240_000);

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
  }, 240_000);

  it('exhausts exactly three confirmed bind exits without touching foreign listeners', async () => {
    await expect(scenario.retriesOnlyThreeConfirmedBindConflicts(3)).resolves.toEqual({
      outcome: { kind: 'rejected' },
      ports: 3,
      distinct: true,
      previousExited: true,
      listeners: ['foreign-listener', 'foreign-listener', 'foreign-listener'],
    });
  }, 120_000);

  it('does not respawn after a real authentication failure', async () => {
    await expect(scenario.doesNotRespawnAfterAuthenticationFailure()).resolves.toEqual({
      outcome: 'rejected',
      postgresStarts: 1,
    });
  }, 240_000);

  it('does not mistake an independent trust server for its owned database', async () => {
    await expect(scenario.rejectsARealTrustServerWithTheWrongNonce()).resolves.toEqual({
      outcome: expect.objectContaining({ kind: 'ready' }),
      postgresStarts: 2,
      ownedPortDiffers: true,
      reachable: true,
      databaseCreated: false,
    });
  }, 120_000);

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
  }, 240_000);

  it('returns retained while repeated close overlaps blocked finalization', async () => {
    await expect(scenario.reportsReleaseWhenARepeatedCloseOverlapsFinalization()).resolves.toEqual({
      firstClose: 'retained',
      ownershipPendingBeforeJournalRelease: true,
      busyWhileJournalBlocked: 'busy',
      secondClosePendingBeforeJournalRelease: false,
      secondCloseResult: {
        kind: 'rejected',
        phase: 'close',
        ownership: 'retained',
        cleanupFailures: [],
      },
      thirdClose: 'resolved',
      stopAttemptsBeforeExit: 1,
      stopAttemptsBeforeIdempotentClose: 1,
      reopenedAfterRelease: 'held',
      completion: { exitCode: 0, signal: null },
    });
  }, 240_000);

  it('bounds PostgreSQL settlement and retries retained ownership after a stale marker is removed', async () => {
    await expect(scenario.retainsOwnershipUntilPostgresSettlementCanBeRetried()).resolves.toEqual({
      firstStop: { kind: 'failed', ownership: 'retained' },
      secondStop: { kind: 'failed', ownership: 'retained' },
      busyWhileMarkerRemains: 'busy',
      ownershipPendingWhileMarkerRemains: true,
      markerPreserved: true,
      postgresStarts: 1,
      retryStop: { kind: 'completed' },
      reopenedAfterRelease: 'held',
    });
  }, 60_000);

  it('rejects resource close when the owned process completion cannot be confirmed', async () => {
    await expect(scenario.rejectsResourceCloseWhenOwnedCompletionFails()).resolves.toEqual({
      firstClose: 'rejected',
      repeatedClose: 'rejected',
    });
  }, 120_000);

  it('preserves invalid preparation rejection without an unhandled derived promise', async () => {
    await expect(scenario.rejectsInvalidPreparationWithoutUnhandledRejection()).resolves.toEqual({
      prepareOutcome: 'rejected:invalid',
      processStartsBeforeClose: 0,
      reopened: 'held',
      unhandled: 0,
    });
  }, 30_000);

  it('observes an early unsafe-marker failure without an unhandled rejection', async () => {
    await expect(
      scenario.observesUnsafePostgresMarkerBeforeCloseWithoutUnhandledRejection(),
    ).resolves.toEqual({
      unhandledBeforeClose: 0,
      unhandledAfterCleanup: 0,
      firstClose: 'retained',
      ownershipPendingWhileMarkerRemains: true,
      busyWhileMarkerRemains: 'busy',
      retryClose: 'released',
      reopenedAfterRelease: 'held',
    });
  }, 30_000);

  it('allows retry when a live-child stop failure is followed by a late marker failure', async () => {
    await expect(scenario.retriesAfterOwnedStopFailureAndLatePostgresMarker()).resolves.toEqual({
      firstStop: { kind: 'failed', ownership: 'retained' },
      repeatedStop: { kind: 'failed', ownership: 'retained' },
      stopAttemptsBeforeExit: 1,
      ownershipPendingBeforeRetry: true,
      busyBeforeRetry: 'busy',
      markerWasPreserved: true,
      retryStop: { kind: 'completed' },
      postgresStarts: 1,
      reopenedAfterRelease: 'held',
    });
  }, 30_000);

  it('retries marker settlement after close races a delayed PostgreSQL spawn', async () => {
    await expect(scenario.retriesMarkerSettlementAfterCloseDuringSpawn()).resolves.toEqual({
      firstClose: 'retained',
      repeatedClose: 'retained',
      stopAttemptsWhileSpawnPaused: 0,
      startup: 'rejected',
      markerWasPreserved: true,
      ownershipPending: true,
      busyWhileMarkerRemains: 'busy',
      retryClose: 'released',
      postgresStarts: 1,
      reopenedAfterRelease: 'held',
    });
  }, 30_000);

  it('cancels an actually spawned owned server before readiness completes', async () => {
    await expect(
      scenario.cancelsAnActuallySpawnedServerBeforeReadinessCompletes(),
    ).resolves.toEqual({
      outcome: {
        kind: 'rejected',
        reason: 'cancelled',
        progressFailure: false,
        observedCompletion: undefined,
      },
      postgresStarts: 1,
      completion: { exitCode: null, signal: 'SIGTERM' },
      cancellationPolicy: { graceMs: 20_000, killWaitMs: 5000 },
    });
  }, 240_000);

  it('does not spawn PostgreSQL when cancellation lands during reservation release', async () => {
    await expect(scenario.abortsAfterReservationReleaseWithoutSpawningPostgres()).resolves.toEqual({
      outcome: 'rejected',
      postgresStarts: 0,
    });
  }, 240_000);

  it('does not publish a dead child after an accepted ready journal write', async () => {
    await expect(scenario.rejectsWhenTheReadyChildExitsDuringAcceptedCompletion()).resolves.toEqual(
      {
        outcome: {
          kind: 'rejected',
          reason: 'cancelled',
          progressFailure: true,
          observedCompletion: undefined,
        },
        closeOutcome: 'rejected',
        completion: { exitCode: 0, signal: null },
        ownershipPendingBeforeJournalRelease: true,
        busyBeforeJournalRelease: 'busy',
        acceptedCompletionPersisted: true,
        terminalOrReadyPersisted: false,
        replacementAfterRelease: 'held',
      },
    );
  }, 240_000);

  it('rejects a child that exits while the completion write is accepted without cancellation', async () => {
    await expect(
      scenario.rejectsWhenTheReadyChildExitsDuringAcceptedCompletion(false),
    ).resolves.toEqual({
      outcome: {
        kind: 'rejected',
        reason: 'process',
        progressFailure: false,
        observedCompletion: { exitCode: 0, signal: null },
      },
      closeOutcome: 'not-requested',
      completion: { exitCode: 0, signal: null },
    });
  }, 240_000);

  it('does not spawn again after startup and owned stop both fail', async () => {
    await expect(
      scenario.rejectsRestartAfterFailedStartupStopUntilTheChildExits(),
    ).resolves.toEqual({
      first: 'rejected',
      repeated: 'rejected',
      startsBeforeExit: 1,
      busy: 'busy',
    });
  }, 240_000);
});
