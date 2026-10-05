import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EmbeddedDataVersionScenario } from '../support/postgres/embedded-data-version-scenario.js';
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

  it('starts when the orphaned server finishes its own shutdown before pg_ctl stops it', async () => {
    const supervisor = await scenario.runningSupervisor();
    await supervisor.kill();

    const restart = await scenario.startWhileTheOrphanShutsDownOnItsOwn(supervisor.postmasterPid);

    expect(restart).toMatchObject({ kind: 'started' });
    await expect(scenario.postgresLog()).resolves.toMatch(/PID file "\S+" does not exist/u);
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

    it('completes on the next start while initdb orphaned by its killed supervisor keeps running', async () => {
      const orphan = await scenario.initializationOrphanedByAKilledSupervisor();

      const restart = await scenario.startResumingDuringInitialization(orphan);
      await orphan.exited();

      expect(restart).toMatchObject({ kind: 'started' });
      await scenario.commit('usable after recovery');
      await expect(scenario.committedValues()).resolves.toEqual(['usable after recovery']);
    });

    it('completes on the next start when an abandoned initialization cannot be removed', async () => {
      await scenario.abandonedInitializationThatCannotBeRemoved();

      await expect(scenario.start()).resolves.toMatchObject({ kind: 'started' });
    });

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

    it('replaces a lock file whose PID now belongs to another user', async () => {
      await scenario.lockFileNaming(await scenario.anotherUsersProcess(), 'an hour earlier');

      await expect(scenario.start()).resolves.toMatchObject({ kind: 'started' });
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

describe('embedded data prepared by another Revo version', { timeout: 60_000 }, () => {
  let scenario: EmbeddedDataVersionScenario;

  beforeEach(async () => {
    scenario = await new EmbeddedDataVersionScenario().setup();
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it('records the version that prepares new data and makes no backup of it', async () => {
    const outcome = await scenario.startAs('0.1.0-alpha.2');

    expect(outcome).toEqual({ kind: 'started' });
    await expect(scenario.recordedVersion()).resolves.toBe('0.1.0-alpha.2');
    await expect(scenario.backup()).resolves.toBeUndefined();
  });

  it('starts the same version again without a backup', async () => {
    await scenario.dataPreparedBy('0.1.0-alpha.2', 'before the restart');

    const outcome = await scenario.startAs('0.1.0-alpha.2');

    expect(outcome).toEqual({ kind: 'started' });
    await expect(scenario.committedValues()).resolves.toEqual(['before the restart']);
    await expect(scenario.backup()).resolves.toBeUndefined();
    await expect(scenario.storedBackups()).resolves.toEqual([]);
  });

  it.each([
    ['0.1.0-alpha.10', '0.1.0-alpha.2'],
    ['0.1.0', '0.1.0-alpha.10'],
    ['0.2.0-alpha.1', '0.1.9'],
  ])(
    'refuses data that Revo %s prepared when this Revo is %s and changes nothing',
    async (newer, older) => {
      await scenario.dataPreparedBy(newer, 'written by the newer version');
      const before = await scenario.databaseSnapshot();

      const outcome = await scenario.startAs(older);

      expect(outcome).toEqual({
        kind: 'rejected',
        reason: 'incompatible',
        message: expect.stringContaining(
          `was last opened by Revo ${newer}, which is newer than this Revo ${older}`,
        ),
      });
      expect(scenario.postgresStarted).toBe(false);
      await expect(scenario.databaseSnapshot()).resolves.toEqual(before);
    },
  );

  it.each([
    ['text that is not JSON', 'revo'],
    ['an unknown format', '{"schemaVersion":2,"version":"0.1.0-alpha.2"}'],
    ['an invalid version', '{"schemaVersion":1,"version":"latest"}'],
  ])('refuses a data version file with %s and changes nothing', async (_, content) => {
    await scenario.dataPreparedBy('0.1.0-alpha.2', 'kept');
    await scenario.dataVersionFileContains(content);
    const before = await scenario.databaseSnapshot();

    const outcome = await scenario.startAs('0.1.0-alpha.2');

    expect(outcome).toEqual({
      kind: 'rejected',
      reason: 'invalid',
      message: expect.stringMatching(
        /data version file \S+data-version\.json is unreadable or has an unknown format/u,
      ),
    });
    expect(scenario.postgresStarted).toBe(false);
    await expect(scenario.databaseSnapshot()).resolves.toEqual(before);
  });

  it('refuses a data version path that is not a file', async () => {
    await scenario.dataPreparedBy('0.1.0-alpha.2', 'kept');
    await scenario.dataVersionFileReplacedByADirectory();

    const outcome = await scenario.startAs('0.1.0-alpha.3');

    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'invalid' });
    expect(scenario.postgresStarted).toBe(false);
    await expect(scenario.backup()).resolves.toBeUndefined();
  });

  it('backs up the earlier data before PostgreSQL starts for a new version', async () => {
    await scenario.dataPreparedBy('0.1.0-alpha.2', 'from alpha.2');

    const outcome = await scenario.startAs('0.1.0-alpha.10');
    await scenario.commit('from alpha.10');
    await scenario.stop();

    expect(outcome).toEqual({ kind: 'started' });
    expect(scenario.dataWhenPostgresStarted()).toEqual({
      recordedVersion: '0.1.0-alpha.10',
      backupVersion: '0.1.0-alpha.2',
    });
    await scenario.restoreBackupAsReadmeDescribes();
    await expect(scenario.startAs('0.1.0-alpha.2')).resolves.toEqual({ kind: 'started' });
    await expect(scenario.committedValues()).resolves.toEqual(['from alpha.2']);
  });

  it('keeps only the latest backup when another version follows', async () => {
    await scenario.dataPreparedBy('0.1.0-alpha.2', 'from alpha.2');
    await scenario.dataPreparedBy('0.1.0-alpha.3', 'from alpha.3');

    await expect(scenario.startAs('0.1.0-alpha.4')).resolves.toEqual({ kind: 'started' });
    await scenario.stop();

    await expect(scenario.storedBackups()).resolves.toHaveLength(1);
    await expect(scenario.backup()).resolves.toMatchObject({ version: '0.1.0-alpha.3' });
    await scenario.restoreBackupAsReadmeDescribes();
    await expect(scenario.startAs('0.1.0-alpha.3')).resolves.toEqual({ kind: 'started' });
    await expect(scenario.committedValues()).resolves.toEqual(['from alpha.2', 'from alpha.3']);
  });

  it('keeps the previous backup through a power cut during a backup and retries on the next start', async () => {
    await scenario.dataPreparedBy('0.1.0-alpha.2', 'from alpha.2');
    await scenario.dataPreparedBy('0.1.0-alpha.3', 'from alpha.3');
    const previous = await scenario.backup();

    await scenario.backupInterruptedByAPowerCutAs('0.1.0-alpha.4');

    await expect(scenario.backup()).resolves.toEqual(previous);
    await expect(scenario.recordedVersion()).resolves.toBe('0.1.0-alpha.3');
    await expect(scenario.startAs('0.1.0-alpha.4')).resolves.toEqual({ kind: 'started' });
    await scenario.stop();
    await expect(scenario.storedBackups()).resolves.toHaveLength(1);
    await expect(scenario.backup()).resolves.toMatchObject({ version: '0.1.0-alpha.3' });
    await scenario.restoreBackupAsReadmeDescribes();
    await expect(scenario.startAs('0.1.0-alpha.3')).resolves.toEqual({ kind: 'started' });
    await expect(scenario.committedValues()).resolves.toEqual(['from alpha.2', 'from alpha.3']);
  });

  it('backs up data written before Revo recorded data versions', async () => {
    await scenario.dataPreparedBy('0.1.0-alpha.2', 'before the version file');
    await scenario.dataVersionFileRemoved();

    await expect(scenario.startAs('0.1.0-alpha.3')).resolves.toEqual({ kind: 'started' });
    await scenario.stop();

    await expect(scenario.recordedVersion()).resolves.toBe('0.1.0-alpha.3');
    await expect(scenario.backup()).resolves.toMatchObject({ version: undefined });
    await scenario.restoreBackupAsReadmeDescribes();
    await expect(scenario.recordedVersion()).resolves.toBeUndefined();
    await expect(scenario.startAs('0.1.0-alpha.2')).resolves.toEqual({ kind: 'started' });
    await expect(scenario.committedValues()).resolves.toEqual(['before the version file']);
  });

  it('does not start a new version without room for the backup', async () => {
    await scenario.dataPreparedBy('0.1.0-alpha.2', 'kept');
    const before = await scenario.databaseSnapshot();

    const outcome = await scenario.startWithoutRoomForABackupAs('0.1.0-alpha.3');

    expect(outcome).toEqual({
      kind: 'rejected',
      reason: 'backup',
      message: expect.stringMatching(/the database backup needs \d+ MiB of free disk space/u),
    });
    expect(scenario.postgresStarted).toBe(false);
    await expect(scenario.databaseSnapshot()).resolves.toEqual(before);
    await expect(scenario.storedBackups()).resolves.toEqual([]);
  });

  it('does not replace a backup path that Revo did not save', async () => {
    await scenario.dataPreparedBy('0.1.0-alpha.2', 'kept');
    await scenario.backupPathOccupiedByAUserDirectory();
    const before = await scenario.databaseSnapshot();

    const outcome = await scenario.startAs('0.1.0-alpha.3');

    expect(outcome).toEqual({
      kind: 'rejected',
      reason: 'backup',
      message: expect.stringMatching(/\S+database-backup is not a backup that Revo saved/u),
    });
    expect(scenario.postgresStarted).toBe(false);
    await expect(scenario.databaseSnapshot()).resolves.toEqual(before);
    await expect(scenario.storedBackups()).resolves.toEqual([]);
  });

  it('leaves an external database without a data version file or backup', async () => {
    const outcome = await scenario.startExternalAs('0.1.0-alpha.3');

    expect(outcome).toEqual({ kind: 'started' });
    await expect(scenario.recordedVersion()).resolves.toBeUndefined();
    await expect(scenario.backup()).resolves.toBeUndefined();
    await expect(scenario.storedBackups()).resolves.toEqual([]);
  });
});
