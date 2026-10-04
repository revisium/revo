import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PostgresLifecycleScenario } from '../support/postgres/postgres-lifecycle-scenario.js';
import { PostgresRecoveryScenario } from '../support/postgres/postgres-recovery-scenario.js';

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

  it('stops an open transaction with a confirmed fast shutdown logged privately', async () => {
    await expect(scenario.stopsAnOpenTransactionWithAFastShutdown()).resolves.toEqual({
      closed: 'confirmed',
      completion: { exitCode: 0, signal: null },
      fastShutdownLogged: true,
      logMode: 0o600,
    });
  });

  it('names the PostgreSQL log when the server cannot start', async () => {
    const result = await scenario.namesThePostgresLogWhenTheServerCannotStart();

    expect(result).toEqual({
      outcome: { kind: 'rejected', message: expect.any(String) },
      failure: { phase: 'postgres-start', logPath: result.logPath },
      errorNamesLog: true,
      logPath: expect.stringMatching(/\/postgres\.log$/u),
      causeLogged: true,
    });
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
      outcome: {
        kind: 'rejected',
        reason: 'cancelled',
        progressFailure: false,
        observedCompletion: undefined,
      },
      completion: { exitCode: null, signal: 'SIGINT' },
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
        outcome: {
          kind: 'rejected',
          reason: 'cancelled',
          progressFailure: true,
          observedCompletion: undefined,
        },
        closeOutcome: 'rejected',
        completion: { exitCode: 0, signal: null },
      },
    );
  }, 10_000);

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

describe('embedded PostgreSQL recovery after a crash', { timeout: 30_000 }, () => {
  let scenario: PostgresRecoveryScenario;

  beforeEach(async () => {
    scenario = await new PostgresRecoveryScenario().setup();
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it('starts after its supervisor is killed and keeps committed data', async () => {
    const supervisor = await scenario.runningSupervisor();
    await scenario.commit('committed before the crash', supervisor.port);

    await supervisor.kill();
    const orphanSurvived = await scenario.isRunning(supervisor.postmasterPid);
    const restart = await scenario.start();

    expect(orphanSurvived).toBe(true);
    expect(restart).toMatchObject({ kind: 'started' });
    await expect(scenario.committedValues()).resolves.toEqual(['committed before the crash']);
    await expect(scenario.isRunning(supervisor.postmasterPid)).resolves.toBe(false);
  });

  it('keeps an orphaned server and its lock file when the clock moved after it started', async () => {
    const supervisor = await scenario.runningSupervisor();
    await supervisor.kill();
    await scenario.clockSteppedForwardSinceTheServerStarted();
    const lockFile = await scenario.lockFile();

    const restart = await scenario.start();

    expect(restart).toMatchObject({ kind: 'rejected', reason: 'locked' });
    await expect(scenario.lockFile()).resolves.toBe(lockFile);
    await expect(scenario.isRunning(supervisor.postmasterPid)).resolves.toBe(true);
    await expect(scenario.postgresLog()).resolves.toContain(
      `process ${String(supervisor.postmasterPid)} works in the cluster directory`,
    );
  });

  describe('an interrupted first initialization', () => {
    it.each(['before-initdb', 'inside-initdb', 'after-initdb'] as const)(
      'completes on the next start when interrupted %s',
      async (point) => {
        await scenario.interruptFirstInitialization(point);

        const restart = await scenario.start();

        expect(restart).toMatchObject({ kind: 'started' });
        await scenario.commit('usable after recovery');
        await expect(scenario.committedValues()).resolves.toEqual(['usable after recovery']);
      },
    );

    it.each([
      ['an empty cluster directory', undefined],
      ['an empty cluster directory and a partly written credential', 'partial'],
    ])('completes on the next start from %s left by an earlier version', async (_, credential) => {
      await scenario.legacyEmptyClusterDirectory(credential);

      await expect(scenario.start()).resolves.toMatchObject({ kind: 'started' });
    });
  });

  describe('a lock file left by an earlier server', () => {
    beforeEach(async () => {
      await scenario.preparedCluster();
    });

    it('replaces a lock file naming an exited process', async () => {
      await scenario.lockFileNaming(await scenario.exitedProcess(), 'an hour earlier');

      await expect(scenario.start()).resolves.toMatchObject({ kind: 'started' });
    });

    it('replaces a lock file whose PID now belongs to a live process without signalling it', async () => {
      const bystander = await scenario.bystander();
      await scenario.lockFileNaming(bystander.pid, 'an hour earlier');

      const restart = await scenario.start();

      expect(restart).toMatchObject({ kind: 'started' });
      await expect(scenario.isRunning(bystander.pid)).resolves.toBe(true);
      await expect(bystander.receivedSignals()).resolves.toEqual([]);
    });

    it('replaces a lock file whose live process works outside the cluster without signalling it', async () => {
      const bystander = await scenario.bystander();
      await scenario.lockFileNaming(bystander.pid, 'an hour later');

      const restart = await scenario.start();

      expect(restart).toMatchObject({ kind: 'started' });
      await expect(bystander.receivedSignals()).resolves.toEqual([]);
    });

    it('replaces an incomplete lock file written before the current boot', async () => {
      await scenario.incompleteLockFile();
      await scenario.lockFileWrittenBeforeBoot();

      await expect(scenario.start()).resolves.toMatchObject({ kind: 'started' });
    });

    it('refuses an incomplete lock file, leaves it in place and logs why', async () => {
      await scenario.incompleteLockFile();

      const restart = await scenario.start();

      expect(restart).toMatchObject({ kind: 'rejected', reason: 'locked' });
      await expect(scenario.lockFile()).resolves.toBe('');
      await expect(scenario.postgresLog()).resolves.toMatch(
        /revo: the lock file \S+postmaster\.pid was left in place because it is incomplete/u,
      );
    });

    it('refuses without a signal when a process in the cluster does not match the recorded start', async () => {
      const bystander = await scenario.bystanderInsideTheCluster();
      await scenario.lockFileNaming(bystander.pid, 'an hour later');
      const lockFile = await scenario.lockFile();

      const restart = await scenario.start();

      expect(restart).toMatchObject({
        kind: 'rejected',
        reason: 'locked',
        message: expect.stringContaining('postmaster.pid'),
      });
      await expect(bystander.receivedSignals()).resolves.toEqual([]);
      await expect(scenario.lockFile()).resolves.toBe(lockFile);
    });

    it('refuses without a signal when the lock file names a server of another data directory', async () => {
      const foreign = await scenario.foreignServer();
      await scenario.lockFileCopiedFrom(foreign);

      const restart = await scenario.start();

      expect(restart).toMatchObject({ kind: 'rejected', reason: 'locked' });
      await expect(foreign.isAlive()).resolves.toBe(true);
    });
  });
});
