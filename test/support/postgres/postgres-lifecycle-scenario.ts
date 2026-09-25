import { lstat, mkdir, mkdtemp, readFile, readlink, rm, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import { Client } from 'pg';

import { EmbeddedPostgresPreparationService } from '../../../src/postgres/embedded-postgres-preparation.service.js';
import { EmbeddedPostgresResourceService } from '../../../src/postgres/embedded-postgres-resource.service.js';
import { EmbeddedPostgresError } from '../../../src/postgres/embedded-postgres.types.js';
import {
  LoopbackPortAllocator,
  type ReservedLoopbackPort,
} from '../../../src/postgres/loopback-port-allocator.js';
import { ControlClientService } from '../../../src/processes/control-client.service.js';
import { ControlDiscoveryService } from '../../../src/processes/control-discovery.service.js';
import type { PublishedControl } from '../../../src/processes/control-discovery.types.js';
import type { ControlStopCompletion } from '../../../src/processes/control-endpoint.types.js';
import type { ManagedProcessRequest } from '../../../src/processes/managed-process.types.js';
import {
  PublishedControlError,
  PublishedControlService,
} from '../../../src/processes/published-control.service.js';
import { OwnedStartupProgress } from '../../../src/startup-progress/startup-progress-facade.js';
import {
  StartupProgressDiscoveryService,
  StartupProgressJournalWriter,
} from '../../../src/startup-progress/startup-progress-journal.service.js';
import { BlockingJournal } from '../startup-progress/blocking-journal.js';
import { cleanupRegistered, closeFixtureOwner, observeFixtureCleanup } from './fixture-cleanup.js';
import { ClusterFixture } from './postgres-readiness-scenario.js';
import { PostgresProcessDiagnosticCollector } from './process-diagnostic-collector.js';
import { TrackedPostgresProcesses } from './tracked-postgres-processes.js';

const FIRST_OPERATION = 'abcdefabcdefabcdefabcdefabcdefab';
const SECOND_OPERATION = '12341234123412341234123412341234';
const LIFECYCLE_CLEANUP_OBSERVATION_MS = 30_000;

const isExpectedLifecycleStopFailure = (error: unknown) =>
  error instanceof PublishedControlError &&
  error.phase === 'close' &&
  error.cleanupFailures.length === 0 &&
  (error.ownership === 'retained' || error.ownership === 'released');

type HeldControl = Extract<PublishedControl, { kind: 'held' }>;

interface CloseableAllocator {
  close(): Promise<void>;
}

interface TrackedCloseOperation {
  readonly promise: Promise<void>;
  state: 'pending' | 'fulfilled' | 'rejected';
  error?: unknown;
}

interface OwnerCleanupRecord {
  readonly closeOperations: TrackedCloseOperation[];
  readonly closeFailures: Set<unknown>;
  readonly releaseFailures: Set<unknown>;
  expectedCloseFailure: (error: unknown) => boolean;
  releaseOperation?: Promise<void>;
}

interface CleanupActionRecord {
  promise?: Promise<void>;
  error?: unknown;
}

class LifecycleScenarioClosingError extends Error {
  constructor() {
    super('PostgreSQL lifecycle scenario is closing');
    this.name = 'LifecycleScenarioClosingError';
  }
}

export class PostgresLifecycleScenario {
  private diagnostics: PostgresProcessDiagnosticCollector | undefined;
  private closing = false;
  private cleanupAttempt: Promise<void> | undefined;
  private readonly acquisitions = new Set<Promise<unknown>>();
  private readonly acquisitionFailures = new Set<unknown>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly owners: HeldControl[] = [];
  private readonly ownerRecords = new WeakMap<HeldControl, OwnerCleanupRecord>();
  private readonly roots: string[] = [];
  private readonly allocators: CloseableAllocator[] = [];
  private readonly processes: TrackedPostgresProcesses[] = [];
  private readonly allocatorOperations = new WeakMap<CloseableAllocator, TrackedCloseOperation>();
  private readonly allocatorFailures = new Map<CloseableAllocator, Set<unknown>>();
  private readonly beforeCloseActions = new Map<() => void | Promise<void>, CleanupActionRecord>();

  async persistsAcrossOwnedRestart() {
    const fixture = await this.fixture();
    const diagnostics =
      process.env.REVO_POSTGRES_LIFECYCLE_DIAGNOSTICS === '1'
        ? new PostgresProcessDiagnosticCollector(fixture.dataDir)
        : undefined;
    this.diagnostics = diagnostics;
    let phase = 'first-start-requested';
    let scenarioError: unknown;
    diagnostics?.scenario(phase);
    const firstProcesses = new TrackedPostgresProcesses({
      owner: 'first',
      ...(diagnostics ? { diagnostics } : {}),
    });
    this.registerProcesses(firstProcesses);
    const firstResource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(firstProcesses),
      firstProcesses,
    );
    const firstOwner = await this.open(fixture, FIRST_OPERATION, undefined, firstResource);
    let secondOwner: Extract<PublishedControl, { kind: 'held' }> | undefined;
    let heldClient: Client | undefined;
    try {
      const first = await this.start(firstOwner, 60_000);
      if (first.kind !== 'embedded') {
        throw new Error('embedded database missing');
      }
      await this.query(fixture.dataDir, first.port, [
        'CREATE TABLE durable_value (value text NOT NULL)',
        "INSERT INTO durable_value (value) VALUES ('survives restart')",
      ]);
      const coalesced = await this.start(firstOwner, 60_000);
      phase = 'first-server-ready';
      diagnostics?.scenario(phase);
      const passwordBefore = await readFile(join(fixture.dataDir, 'postgres-password'), 'utf8');
      heldClient = new Client({
        host: '127.0.0.1',
        port: first.port,
        user: 'postgres',
        password: passwordBefore,
        database: 'revo',
        ssl: false,
      });
      const closeHeldClient = async () => {
        const client = heldClient;
        if (client) {
          heldClient = undefined;
          await client.end();
        }
      };
      this.registerBeforeClose(closeHeldClient);
      await this.trackOperation(async () => {
        await heldClient?.connect();
        await heldClient?.query('SELECT 1');
      });

      phase = 'first-close-requested';
      diagnostics?.scenario(phase);
      const firstClose = this.requestOwnerClose(firstOwner);
      await firstProcesses.postgresStopRequested;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const completedBeforeRelease = firstProcesses.completedPostgres;
      phase = 'held-client-release-requested';
      diagnostics?.scenario(phase, { completedPostgresBeforeRelease: completedBeforeRelease });
      await this.runBeforeCloseAction(closeHeldClient);
      phase = 'held-client-released';
      diagnostics?.scenario(phase);
      await firstClose;
      const firstCompletion = await firstProcesses.completion;
      if (!firstCompletion) {
        throw new Error('first PostgreSQL completion missing');
      }
      phase = 'first-owner-closed';
      diagnostics?.scenario(phase, {
        exitCode: firstCompletion.exitCode,
        signal: firstCompletion.signal,
      });

      const secondProcesses = new TrackedPostgresProcesses({
        owner: 'second',
        ...(diagnostics ? { diagnostics } : {}),
      });
      this.registerProcesses(secondProcesses);
      const secondResource = new EmbeddedPostgresResourceService(
        new EmbeddedPostgresPreparationService(secondProcesses),
        secondProcesses,
      );
      const openedSecond = await this.open(fixture, SECOND_OPERATION, undefined, secondResource);
      if (openedSecond.kind !== 'held' || !openedSecond.startDatabase) {
        throw new Error('database owner missing');
      }
      secondOwner = openedSecond;
      phase = 'second-start-requested';
      diagnostics?.scenario(phase);
      const second = await this.start(secondOwner, 60_000);
      if (second.kind !== 'embedded') {
        throw new Error('embedded database missing');
      }
      const rows = await this.query(fixture.dataDir, second.port, [
        'SELECT value FROM durable_value',
      ]);
      phase = 'second-server-ready';
      diagnostics?.scenario(phase);
      const passwordAfter = await readFile(join(fixture.dataDir, 'postgres-password'), 'utf8');
      phase = 'second-close-requested';
      diagnostics?.scenario(phase);
      await this.requestOwnerClose(secondOwner);
      const secondCompletion = await secondProcesses.completion;
      if (!secondCompletion) {
        throw new Error('second PostgreSQL completion missing');
      }
      phase = 'complete';
      diagnostics?.scenario(phase, {
        exitCode: secondCompletion.exitCode,
        signal: secondCompletion.signal,
      });
      return {
        first,
        coalesced,
        second,
        rows,
        passwordLength: passwordAfter.length,
        passwordPreserved: passwordBefore === passwordAfter,
        completedBeforeRelease,
        firstCompletion,
        secondCompletion,
        firstCancellationPolicies: firstProcesses.postgresCancellationPolicies,
        firstStopPolicies: firstProcesses.postgresStopPolicies,
        secondCancellationPolicies: secondProcesses.postgresCancellationPolicies,
        secondStopPolicies: secondProcesses.postgresStopPolicies,
      };
    } catch (error) {
      scenarioError = error;
      phase = 'scenario-failed';
      diagnostics?.scenario(phase, {
        name: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message : String(error),
        reason:
          error instanceof EmbeddedPostgresError ? error.reason : 'not-embedded-postgres-error',
        observedCompletion:
          error instanceof EmbeddedPostgresError && error.observedCompletion
            ? `${error.observedCompletion.exitCode ?? 'null'}/${error.observedCompletion.signal ?? 'none'}`
            : 'none',
      });
      throw error;
    } finally {
      phase = 'scenario-finally';
      diagnostics?.scenario(phase);
      await diagnostics?.waitForStderr(250);
      phase = 'scenario-returning';
      diagnostics?.scenario(phase);
      if (diagnostics) {
        console.error(diagnostics.formatReport(phase, scenarioError));
      }
    }
  }

  async rejectsAnAlreadyCancelledStart() {
    const fixture = await this.fixture();
    const owner = await this.open(fixture, FIRST_OPERATION);
    const controller = new AbortController();
    controller.abort();
    const outcome = await this.start(owner, 5000, controller.signal).then(
      () => 'resolved',
      () => 'rejected',
    );
    await this.requestOwnerClose(owner);
    return outcome;
  }

  async retriesOnlyThreeConfirmedBindConflicts(conflicts: number) {
    const fixture = await this.fixture();
    const diagnostics =
      process.env.REVO_POSTGRES_LIFECYCLE_DIAGNOSTICS === '1'
        ? new PostgresProcessDiagnosticCollector(fixture.dataDir)
        : undefined;
    this.diagnostics = diagnostics;
    diagnostics?.scenario('fixture-ready', {
      conflicts,
      dataDirectory: fixture.dataDir,
    });
    const processes = new TrackedPostgresProcesses({
      owner: 'bind-retry',
      ...(diagnostics ? { diagnostics } : {}),
    });
    this.registerProcesses(processes);
    const allocator = new ContendedPortAllocator(processes, conflicts, diagnostics);
    this.registerAllocator(allocator);
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
      allocator,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, allocator, resource);
    const outcome = await this.start(owner).then(
      (started) => {
        if (started.kind !== 'embedded') {
          throw new Error('embedded database missing');
        }
        return { kind: 'ready' as const, port: started.port };
      },
      (error: unknown) => {
        diagnostics?.scenario('start-rejected', {
          name: describeDiagnosticError(error),
          reason: error instanceof EmbeddedPostgresError ? error.reason : 'unknown',
          observedCompletion:
            error instanceof EmbeddedPostgresError && error.observedCompletion
              ? `${error.observedCompletion.exitCode ?? 'null'}/${error.observedCompletion.signal ?? 'none'}`
              : 'none',
        });
        return { kind: 'rejected' as const };
      },
    );
    try {
      diagnostics?.scenario('listeners-inspection-requested', {
        count: allocator.ports.length,
      });
      const listeners = await allocator.inspectListeners();
      diagnostics?.scenario('listeners-inspection-resolved', {
        count: listeners.length,
      });
      return {
        outcome,
        ports: allocator.ports.length,
        distinct: new Set(allocator.ports).size === allocator.ports.length,
        previousExited: allocator.previousExited,
        listeners,
      };
    } finally {
      await this.requestOwnerClose(owner);
      diagnostics?.scenario('scenario-returning');
      if (diagnostics) {
        await diagnostics.waitForStderr(250);
        console.error(diagnostics.formatReport('scenario-returning'));
      }
    }
  }

  async doesNotRespawnAfterAuthenticationFailure() {
    const fixture = await this.fixture();
    const diagnostics =
      process.env.REVO_POSTGRES_LIFECYCLE_DIAGNOSTICS === '1'
        ? new PostgresProcessDiagnosticCollector(fixture.dataDir)
        : undefined;
    this.diagnostics = diagnostics;
    diagnostics?.scenario('fixture-ready', { dataDirectory: fixture.dataDir });
    const processes = new TrackedPostgresProcesses({
      owner: 'auth-failure',
      ...(diagnostics ? { diagnostics } : {}),
    });
    this.registerProcesses(processes);
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource);
    let scenarioError: unknown;
    try {
      await this.prepare(owner, 120_000);
      diagnostics?.scenario('credential-replaced');
      await writeFile(
        join(fixture.dataDir, 'postgres-password'),
        'ffffffffffffffffffffffffffffffff',
        {
          mode: 0o600,
        },
      );
      const outcome = await this.start(owner).then(
        () => 'resolved',
        () => 'rejected',
      );
      await this.requestOwnerClose(owner);
      return { outcome, postgresStarts: processes.postgresStarts };
    } catch (error) {
      scenarioError = error;
      diagnostics?.scenario('scenario-failed', {
        name: describeDiagnosticError(error),
        reason: error instanceof EmbeddedPostgresError ? error.reason : 'unknown',
        progressFailure: error instanceof EmbeddedPostgresError ? error.progressFailure : false,
        observedCompletion:
          error instanceof EmbeddedPostgresError && error.observedCompletion
            ? `${error.observedCompletion.exitCode ?? 'null'}/${error.observedCompletion.signal ?? 'none'}`
            : 'none',
      });
      throw error;
    } finally {
      await diagnostics?.waitForStderr(250);
      if (diagnostics) {
        console.error(diagnostics.formatReport('scenario-returning', scenarioError));
      }
    }
  }

  async rejectsARealTrustServerWithTheWrongNonce() {
    const fixture = await this.fixture();
    const allocator = new ForeignPostgresAllocator();
    this.registerAllocator(allocator);
    const owner = await this.open(fixture, FIRST_OPERATION, allocator);
    const started = await this.start(owner, 90_000);
    if (started.kind !== 'embedded') {
      throw new Error('embedded database missing');
    }
    const outcome = { kind: 'ready' as const, port: started.port };
    await this.requestOwnerClose(owner);
    return {
      outcome,
      postgresStarts: allocator.ownedAttempts,
      ownedPortDiffers: outcome.kind === 'ready' && outcome.port !== allocator.foreignPort,
      ...(await allocator.inspect()),
    };
  }

  async retainsOwnershipAfterStopFailureUntilTheOwnedServerActuallyExits() {
    const fixture = await this.fixture();
    const processes = new TrackedPostgresProcesses({ failFirstPostgresStop: true });
    this.registerProcesses(processes);
    const journal = new BlockingJournal();
    this.registerBeforeClose(() => journal.release());
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource, journal, true);
    try {
      await this.prepare(owner, 120_000);
      await this.start(owner);
      if (!owner.progress) {
        throw new Error('startup progress missing');
      }
      journal.blockNext();
      const pendingProgress = owner.progress.progress('api-readiness');
      const progressOutcome = pendingProgress.then(
        () => 'fulfilled' as const,
        () => 'rejected' as const,
      );
      await waitForGate(journal.entered, progressOutcome);
      const discovered = await new ControlDiscoveryService().read(fixture.dataDir);
      if (discovered.kind !== 'found') {
        throw new Error('control missing');
      }
      const closeOutcome = await new ControlClientService().requestStopAndWait(
        discovered.record,
        2_000,
        { timeoutMs: 500, maxFrameBytes: 16_384 },
      );
      const busy = await this.openResult(fixture, SECOND_OPERATION);
      const repeatedCloseOperation = this.requestOwnerClose(owner).then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      await waitForGate(
        repeatedCloseOperation.then(() => undefined),
        new Promise<never>(() => undefined),
        2_000,
      );
      const repeatedClose = await repeatedCloseOperation;
      await processes.release();
      const beforeJournalDrain = await this.openResult(fixture, SECOND_OPERATION);
      journal.release();
      await pendingProgress;
      const reopened = await this.acquireEventually(fixture, SECOND_OPERATION, Date.now() + 2000);
      const endpointRetry = await new ControlClientService().requestStop(discovered.record).then(
        () => 'accepted' as const,
        () => 'rejected' as const,
      );
      if (reopened?.kind === 'held') {
        await this.requestOwnerClose(reopened);
      }
      return {
        closeOutcome,
        repeatedClose,
        busy: busy.kind,
        beforeJournalDrain: beforeJournalDrain.kind,
        reopened: reopened?.kind,
        endpointRetry,
        completion: await processes.completion,
      };
    } finally {
      journal.release();
    }
  }

  async reportsReleaseWhenARepeatedCloseOverlapsFinalization() {
    const fixture = await this.fixture();
    const processes = new TrackedPostgresProcesses({ failFirstPostgresStop: true });
    this.registerProcesses(processes);
    const journal = new BlockingJournal();
    this.registerBeforeClose(() => journal.release());
    this.registerBeforeClose(() => processes.release());
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource, journal);
    let notifyProgressClose!: () => void;
    const progressCloseEntered = new Promise<void>((resolve) => {
      notifyProgressClose = resolve;
    });
    const closeDescriptor = Object.getOwnPropertyDescriptor(
      OwnedStartupProgress.prototype,
      'close',
    );
    if (!closeDescriptor || !isOwnedStartupProgressClose(closeDescriptor.value)) {
      throw new Error('Owned startup progress close method is unavailable');
    }
    const originalProgressClose = closeDescriptor.value;
    const observedProgressClose = function (this: OwnedStartupProgress) {
      if (this === owner.progress) {
        notifyProgressClose();
      }
      return originalProgressClose.call(this);
    };
    OwnedStartupProgress.prototype.close = observedProgressClose;
    try {
      await this.prepare(owner, 120_000);
      await this.start(owner);
      if (!owner.progress) {
        throw new Error('startup progress missing');
      }
      journal.blockNext();
      const pendingProgress = owner.progress.progress('api-readiness');
      const progressOutcome = pendingProgress.then(
        () => 'fulfilled' as const,
        () => 'rejected' as const,
      );
      await waitForGate(journal.entered, progressOutcome);
      this.expectFaultInjectedStopFailure(owner);
      const firstClose = await this.requestOwnerClose(owner).then(
        () => 'resolved' as const,
        (error: unknown) => {
          if (
            !(error instanceof PublishedControlError) ||
            !isExpectedLifecycleStopFailure(error) ||
            error.ownership !== 'retained'
          ) {
            throw error;
          }
          return 'retained' as const;
        },
      );
      const stopAttemptsBeforeExit = processes.postgresStopPolicies.length;
      await processes.release();
      await waitForGate(
        progressCloseEntered,
        pendingProgress.then(() => undefined),
      );
      const ownershipReleased = this.ownerRelease(owner).then(
        () => true,
        () => false,
      );
      const ownershipPendingBeforeJournalRelease = await Promise.race([
        ownershipReleased.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 25)),
      ]);
      const busy = await this.openResult(fixture, SECOND_OPERATION);

      let secondCloseSettled = false;
      const secondClose = this.requestOwnerClose(owner).then(
        () => {
          secondCloseSettled = true;
          return { kind: 'resolved' as const };
        },
        (error: unknown) => {
          secondCloseSettled = true;
          if (!(error instanceof PublishedControlError)) {
            throw error;
          }
          return {
            kind: 'rejected' as const,
            phase: error.phase,
            ownership: error.ownership,
            cleanupFailures: error.cleanupFailures,
          };
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const secondClosePendingBeforeJournalRelease = !secondCloseSettled;

      journal.release();
      await pendingProgress;
      await ownershipReleased;
      const secondCloseResult = await secondClose;
      const stopAttemptsBeforeIdempotentClose = processes.postgresStopPolicies.length;
      const thirdClose = await this.requestOwnerClose(owner).then(() => 'resolved' as const);
      const reopened = await this.acquireEventually(fixture, SECOND_OPERATION, Date.now() + 2_000);
      if (reopened.kind === 'held') {
        await this.requestOwnerClose(reopened);
      }
      return {
        firstClose,
        ownershipPendingBeforeJournalRelease,
        busyWhileJournalBlocked: busy.kind,
        secondClosePendingBeforeJournalRelease,
        secondCloseResult,
        thirdClose,
        stopAttemptsBeforeExit,
        stopAttemptsBeforeIdempotentClose,
        reopenedAfterRelease: reopened.kind,
        completion: await processes.completion,
      };
    } finally {
      journal.release();
      if (OwnedStartupProgress.prototype.close === observedProgressClose) {
        OwnedStartupProgress.prototype.close = originalProgressClose;
      }
    }
  }

  async retainsOwnershipUntilPostgresSettlementCanBeRetried() {
    const fixture = await this.fixture();
    const processes = new TrackedPostgresProcesses({ postmasterPidAfterExit: 'file' });
    this.registerProcesses(processes);
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource, undefined, true);
    const markerPath = join(fixture.dataDir, 'postgres', 'postmaster.pid');
    try {
      await this.prepare(owner, 120_000);
      await this.start(owner);
      const discovered = await new ControlDiscoveryService().read(fixture.dataDir);
      if (discovered.kind !== 'found') {
        throw new Error('control missing');
      }
      const client = new ControlClientService();
      const stop = async () => {
        const result = await client
          .requestStopAndWait(discovered.record, 8_000)
          .catch(() => ({ kind: 'transport-failed' as const }));
        return result.kind === 'failed'
          ? { kind: result.kind, ownership: result.ownership }
          : result;
      };

      const firstStop = await stop();
      const marker = await readFile(markerPath, 'utf8');
      const ownershipReleased = this.ownerRelease(owner).then(
        () => true,
        () => true,
      );
      const ownershipPendingWhileMarkerRemains = await Promise.race([
        ownershipReleased.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 25)),
      ]);
      const busy = await this.openResult(fixture, SECOND_OPERATION);
      const secondStop = await stop();
      const markerPreserved = (await readFile(markerPath, 'utf8')) === marker;
      const postgresStarts = processes.postgresStarts;

      if (marker !== 'fixture-retained-postmaster-marker\n') {
        throw new Error('fixture did not retain its PostgreSQL marker');
      }
      await unlink(markerPath);
      const retryStop = await stop();
      if (retryStop.kind === 'completed') {
        await ownershipReleased;
      }
      const reopened = await this.acquireEventually(fixture, SECOND_OPERATION, Date.now() + 3_000);
      if (reopened.kind === 'held') {
        await this.requestOwnerClose(reopened);
      }
      return {
        firstStop,
        secondStop,
        busyWhileMarkerRemains: busy.kind,
        ownershipPendingWhileMarkerRemains,
        markerPreserved,
        postgresStarts,
        retryStop,
        reopenedAfterRelease: reopened.kind,
      };
    } finally {
      const marker = await readFile(markerPath, 'utf8').catch(() => undefined);
      if (marker === 'fixture-retained-postmaster-marker\n') {
        await unlink(markerPath);
      }
    }
  }

  async rejectsResourceCloseWhenOwnedCompletionFails() {
    const fixture = await this.fixture();
    const processes = new TrackedPostgresProcesses({ failPostgresCompletionAfterExit: true });
    this.registerProcesses(processes);
    const journal = new StartupProgressJournalWriter();
    const progress = new OwnedStartupProgress(journal, fixture.dataDir, {
      operationId: '98769876987698769876987698769876',
      now: () => performance.now(),
    });
    await progress.initialize();
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    ).bind(fixture.dataDir, progress);
    try {
      await resource.prepareEmbeddedPostgres({
        signal: new AbortController().signal,
        timeoutMs: 120_000,
      });
      await resource.start({ signal: new AbortController().signal, timeoutMs: 60_000 });
      await processes.stopPostgresForFixture();
      await processes.waitForInjectedCompletionFailure();
      await new Promise<void>((resolve) => setImmediate(resolve));

      const firstClose = await resource.close().then(
        () => 'resolved' as const,
        (error: unknown) =>
          error instanceof EmbeddedPostgresError ? ('rejected' as const) : ('wrong-error' as const),
      );
      const repeatedClose = await resource.close().then(
        () => 'resolved' as const,
        (error: unknown) =>
          error instanceof EmbeddedPostgresError ? ('rejected' as const) : ('wrong-error' as const),
      );
      return { firstClose, repeatedClose };
    } finally {
      await progress.close();
    }
  }

  async rejectsInvalidPreparationWithoutUnhandledRejection() {
    const fixture = await this.fixture();
    const processes = new TrackedPostgresProcesses();
    this.registerProcesses(processes);
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource);
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const prepareOutcome = await this.prepare(owner, 0).then(
        () => 'resolved' as const,
        (error: unknown) =>
          error instanceof EmbeddedPostgresError ? `rejected:${error.reason}` : 'rejected:unknown',
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const processStartsBeforeClose = processes.processStarts;
      await this.requestOwnerClose(owner);
      await this.ownerRelease(owner);
      const reopened = await this.openResult(fixture, SECOND_OPERATION);
      if (reopened.kind === 'held') {
        await this.requestOwnerClose(reopened);
      }
      await this.cleanup();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      return {
        prepareOutcome,
        processStartsBeforeClose,
        reopened: reopened.kind,
        unhandled: unhandled.length,
      };
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  }

  async observesUnsafePostgresMarkerBeforeCloseWithoutUnhandledRejection(
    hooks: {
      readonly afterMarkerRead?: () => Promise<void>;
      readonly afterRetainedClose?: () => Promise<void>;
    } = {},
  ) {
    const fixture = await this.fixture();
    const processes = new TrackedPostgresProcesses({ postmasterPidAfterExit: 'symlink' });
    this.registerProcesses(processes);
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource);
    const markerPath = join(fixture.dataDir, 'postgres', 'postmaster.pid');
    const markerTarget = `${markerPath}.fixture-target`;
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    const cleanupFailures: unknown[] = [];
    let bodyFailed = false;
    let bodyError: unknown;
    let result:
      | {
          unhandledBeforeClose: number;
          firstClose: 'released' | 'retained';
          ownershipPendingWhileMarkerRemains: boolean;
          busyWhileMarkerRemains: PublishedControl['kind'];
          retryClose: 'released';
          reopenedAfterRelease: PublishedControl['kind'];
        }
      | undefined;
    const isMissingPath = (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT';
    const removeOwnedMarker = async () => {
      let destination: string;
      try {
        destination = await readlink(markerPath);
      } catch (error) {
        if (isMissingPath(error)) {
          return;
        }
        throw error;
      }
      if (destination !== markerTarget) {
        throw new Error('PostgreSQL fixture marker symlink changed ownership');
      }
      await unlink(markerPath);
    };
    const removeOwnedTarget = async () => {
      let metadata;
      try {
        metadata = await lstat(markerTarget);
      } catch (error) {
        if (isMissingPath(error)) {
          return;
        }
        throw error;
      }
      if (!metadata.isFile()) {
        throw new Error('PostgreSQL fixture marker target is not a regular file');
      }
      if ((await readFile(markerTarget, 'utf8')) !== 'fixture-postmaster-marker-target\n') {
        throw new Error('PostgreSQL fixture marker target changed ownership');
      }
      await unlink(markerTarget);
    };
    const captureCleanup = async (phase: string, action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        cleanupFailures.push(
          new Error(`PostgreSQL fixture cleanup failed: ${phase}`, { cause: error }),
        );
      }
    };

    process.on('unhandledRejection', onUnhandledRejection);
    try {
      try {
        await this.prepare(owner, 120_000);
        await this.start(owner);
        await processes.stopPostgresForFixture();
        if ((await readlink(markerPath)) !== markerTarget) {
          throw new Error('fixture-owned PostgreSQL marker symlink missing');
        }
        await hooks.afterMarkerRead?.();
        await Promise.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
        const unhandledBeforeClose = unhandled.length;

        this.expectFaultInjectedStopFailure(owner);
        const firstClose = await this.requestOwnerClose(owner).then(
          () => 'released' as const,
          (error: unknown) => {
            if (!isExpectedLifecycleStopFailure(error)) {
              throw error;
            }
            return 'retained' as const;
          },
        );
        await hooks.afterRetainedClose?.();
        const ownershipReleased = this.ownerRelease(owner);
        const ownershipPendingWhileMarkerRemains = await Promise.race([
          ownershipReleased.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 25)),
        ]);
        const busy = await this.openResult(fixture, SECOND_OPERATION);
        await removeOwnedMarker();
        await removeOwnedTarget();
        const retryClose = await this.requestOwnerClose(owner).then(() => 'released' as const);
        await ownershipReleased;
        const reopened = await this.acquireEventually(
          fixture,
          SECOND_OPERATION,
          Date.now() + 3_000,
        );
        if (reopened.kind === 'held') {
          await this.requestOwnerClose(reopened);
        }
        result = {
          unhandledBeforeClose,
          firstClose,
          ownershipPendingWhileMarkerRemains,
          busyWhileMarkerRemains: busy.kind,
          retryClose,
          reopenedAfterRelease: reopened.kind,
        };
      } catch (error) {
        bodyFailed = true;
        bodyError = error;
      }
    } finally {
      await captureCleanup('owned PostgreSQL process release', () => processes.release());
      await captureCleanup('owned marker symlink removal', removeOwnedMarker);
      await captureCleanup('owned marker target removal', removeOwnedTarget);
      await captureCleanup('fixture cleanup', () => this.cleanup());
      await captureCleanup('event-loop checkpoint', async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      if (unhandled.length > 0) {
        cleanupFailures.push(
          new AggregateError(
            [...unhandled],
            'Unhandled rejections during PostgreSQL scenario and cleanup',
          ),
        );
      }
      process.off('unhandledRejection', onUnhandledRejection);
    }
    if (bodyFailed && cleanupFailures.length > 0) {
      throw new AggregateError(
        [bodyError, ...cleanupFailures],
        'PostgreSQL scenario and cleanup failed',
        { cause: bodyError },
      );
    }
    if (bodyFailed) {
      throw bodyError;
    }
    if (cleanupFailures.length === 1) {
      throw cleanupFailures[0];
    }
    if (cleanupFailures.length > 1) {
      throw new AggregateError(cleanupFailures, 'PostgreSQL scenario cleanup failed');
    }
    if (!result) {
      throw new Error('PostgreSQL unsafe-marker scenario produced no result');
    }
    return { ...result, unhandledAfterCleanup: unhandled.length };
  }

  async retriesAfterOwnedStopFailureAndLatePostgresMarker() {
    const fixture = await this.fixture();
    const processes = new TrackedPostgresProcesses({
      failFirstPostgresStop: true,
      postmasterPidAfterExit: 'file',
    });
    this.registerProcesses(processes);
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource, undefined, true);
    const markerPath = join(fixture.dataDir, 'postgres', 'postmaster.pid');
    const summarizeStop = async () => {
      const discovered = await new ControlDiscoveryService().read(fixture.dataDir);
      if (discovered.kind !== 'found') {
        throw new Error('control missing');
      }
      const result = await new ControlClientService()
        .requestStopAndWait(discovered.record, 8_000)
        .catch(() => ({ kind: 'transport-failed' as const }));
      return result.kind === 'failed' ? { kind: result.kind, ownership: result.ownership } : result;
    };
    try {
      await this.prepare(owner, 120_000);
      await this.start(owner);
      const firstStop = await summarizeStop();
      const repeatedStop = await summarizeStop();
      const stopAttemptsBeforeExit = processes.postgresStopPolicies.length;
      await processes.release();
      const marker = await readFile(markerPath, 'utf8');
      await new Promise<void>((resolve) => setTimeout(resolve, 5_250));
      const ownershipReleased = this.ownerRelease(owner).then(
        () => true,
        () => true,
      );
      const ownershipPendingBeforeRetry = await Promise.race([
        ownershipReleased.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 25)),
      ]);
      const busy = await this.openResult(fixture, SECOND_OPERATION);
      const markerWasPreserved = marker === 'fixture-retained-postmaster-marker\n';
      if (!markerWasPreserved) {
        throw new Error('fixture did not retain its PostgreSQL marker');
      }
      await unlink(markerPath);
      const retryStop = await summarizeStop();
      if (retryStop.kind === 'completed') {
        await ownershipReleased;
      }
      const reopened = await this.acquireEventually(fixture, SECOND_OPERATION, Date.now() + 3_000);
      if (reopened.kind === 'held') {
        await this.requestOwnerClose(reopened);
      }
      return {
        firstStop,
        repeatedStop,
        stopAttemptsBeforeExit,
        ownershipPendingBeforeRetry,
        busyBeforeRetry: busy.kind,
        markerWasPreserved,
        retryStop,
        postgresStarts: processes.postgresStarts,
        reopenedAfterRelease: reopened.kind,
      };
    } finally {
      const marker = await readFile(markerPath, 'utf8').catch(() => undefined);
      if (marker === 'fixture-retained-postmaster-marker\n') {
        await unlink(markerPath);
      }
    }
  }

  async retriesMarkerSettlementAfterCloseDuringSpawn() {
    const fixture = await this.fixture();
    const processes = new PausedSpawnProcesses(undefined, {
      postmasterPidAfterExit: 'file',
    });
    this.registerProcesses(processes);
    this.registerBeforeClose(() => processes.continue('before-close'));
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource);
    const markerPath = join(fixture.dataDir, 'postgres', 'postmaster.pid');
    let starting: Promise<unknown> | undefined;
    try {
      await this.prepare(owner, 120_000);
      starting = this.start(owner, 30_000).then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      await waitForGate(processes.spawned, starting, 5_000);
      this.expectFaultInjectedStopFailure(owner);
      const firstClose = await this.requestOwnerClose(owner).then(
        () => 'released' as const,
        (error: unknown) => {
          if (!isExpectedLifecycleStopFailure(error)) {
            throw error;
          }
          return 'retained' as const;
        },
      );
      const repeatedClose = await this.requestOwnerClose(owner).then(
        () => 'released' as const,
        (error: unknown) => {
          if (!isExpectedLifecycleStopFailure(error)) {
            throw error;
          }
          return 'retained' as const;
        },
      );
      const stopAttemptsWhileSpawnPaused = processes.postgresStopPolicies.length;
      processes.continue('after-explicit-abort');
      const startup = await starting;
      await processes.completion;
      const marker = await readFile(markerPath, 'utf8');
      const ownershipReleased = this.ownerRelease(owner).then(
        () => true,
        () => true,
      );
      const ownershipPending = await Promise.race([
        ownershipReleased.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 25)),
      ]);
      const busy = await this.openResult(fixture, SECOND_OPERATION);
      const markerWasPreserved = marker === 'fixture-retained-postmaster-marker\n';
      if (!markerWasPreserved) {
        throw new Error('fixture did not retain its PostgreSQL marker');
      }
      await unlink(markerPath);
      const retryClose = await this.requestOwnerClose(owner).then(() => 'released' as const);
      await ownershipReleased;
      const reopened = await this.acquireEventually(fixture, SECOND_OPERATION, Date.now() + 3_000);
      if (reopened.kind === 'held') {
        await this.requestOwnerClose(reopened);
      }
      return {
        firstClose,
        repeatedClose,
        stopAttemptsWhileSpawnPaused,
        startup,
        markerWasPreserved,
        ownershipPending,
        busyWhileMarkerRemains: busy.kind,
        retryClose,
        postgresStarts: processes.postgresStarts,
        reopenedAfterRelease: reopened.kind,
      };
    } finally {
      processes.continue('scenario-finally');
      const marker = await readFile(markerPath, 'utf8').catch(() => undefined);
      if (marker === 'fixture-retained-postmaster-marker\n') {
        await unlink(markerPath);
      }
    }
  }

  async cancelsAnActuallySpawnedServerBeforeReadinessCompletes() {
    const fixture = await this.fixture();
    const diagnostics =
      process.env.REVO_POSTGRES_LIFECYCLE_DIAGNOSTICS === '1'
        ? new PostgresProcessDiagnosticCollector(fixture.dataDir)
        : undefined;
    this.diagnostics = diagnostics;
    diagnostics?.scenario('fixture-ready', { dataDirectory: fixture.dataDir });
    const processes = new PausedSpawnProcesses(diagnostics);
    this.registerProcesses(processes);
    this.registerBeforeClose(() => processes.continue('before-close'));
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource);
    let scenarioError: unknown;
    try {
      await this.prepare(owner, 120_000);
      const controller = new AbortController();
      const starting = this.start(owner, 30_000, controller.signal).then(
        toOutcome,
        toDiagnosticRejectedOutcome,
      );
      diagnostics?.scenario('gate-wait-requested', { timeoutMs: 5_000 });
      try {
        await waitForGate(processes.spawned, starting);
        diagnostics?.scenario('gate-reached');
      } catch (error) {
        diagnostics?.scenario('gate-wait-failed', {
          error: describeDiagnosticError(error),
          postgresStarts: processes.postgresStarts,
          inputSignalAborted: controller.signal.aborted,
        });
        throw error;
      }
      diagnostics?.scenario('explicit-abort-requested');
      controller.abort();
      processes.continue('after-explicit-abort');
      const outcome = await starting;
      diagnostics?.scenario('starting-settled', {
        outcome:
          typeof outcome === 'string' ? outcome : 'kind' in outcome ? outcome.kind : 'unknown',
        reason:
          typeof outcome === 'object' && outcome !== null && 'reason' in outcome
            ? outcome.reason
            : 'none',
      });
      return {
        outcome,
        completion: await processes.completion,
        cancellationPolicy: processes.cancellationPolicy,
        postgresStarts: processes.postgresStarts,
      };
    } catch (error) {
      scenarioError = error;
      diagnostics?.scenario('scenario-failed', {
        error: describeDiagnosticError(error),
        postgresStarts: processes.postgresStarts,
      });
      throw error;
    } finally {
      processes.continue('scenario-finally');
      diagnostics?.scenario('scenario-finally', {
        postgresStarts: processes.postgresStarts,
      });
      await diagnostics?.waitForStderr(250);
      if (diagnostics) {
        console.error(diagnostics.formatReport('scenario-returning', scenarioError));
      }
    }
  }

  async abortsAfterReservationReleaseWithoutSpawningPostgres() {
    const fixture = await this.fixture();
    const ports = new GatedReleaseAllocator();
    this.registerAllocator(ports);
    this.registerBeforeClose(() => ports.continue());
    const processes = new TrackedPostgresProcesses();
    this.registerProcesses(processes);
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
      ports,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, ports, resource);
    try {
      await this.prepare(owner, 120_000);
      const controller = new AbortController();
      const starting = this.start(owner, 30_000, controller.signal).then(
        toOutcome,
        toRejectedOutcome,
      );
      await waitForGate(ports.releasing, starting, 5_000);
      controller.abort();
      ports.continue();
      const outcome = await starting;
      return { outcome, postgresStarts: processes.postgresStarts };
    } finally {
      ports.continue();
    }
  }

  async rejectsWhenTheReadyChildExitsDuringAcceptedCompletion(closeWhileBlocked = true) {
    const fixture = await this.fixture();
    const processes = new TrackedPostgresProcesses();
    this.registerProcesses(processes);
    const journal = new BlockingJournal();
    this.registerBeforeClose(() => journal.release());
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource, journal);
    try {
      await this.prepare(owner, 120_000);
      journal.blockPostgresCompletion();
      const starting = this.start(owner, 30_000).then(toOutcome, toDiagnosticRejectedOutcome);
      await waitForGate(journal.entered, starting);
      if (closeWhileBlocked) {
        this.expectFaultInjectedStopFailure(owner);
      }
      const closing = closeWhileBlocked
        ? this.requestOwnerClose(owner).then(toOutcome, toRejectedOutcome)
        : Promise.resolve('not-requested');
      if (!closeWhileBlocked) {
        await processes.release();
      }
      const completion = await processes.completion;
      const ownershipReleased = closeWhileBlocked ? this.ownerRelease(owner) : undefined;
      const ownershipPendingBeforeJournalRelease = ownershipReleased
        ? await Promise.race([
            ownershipReleased.then(() => false),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 25)),
          ])
        : false;
      const busyBeforeJournalRelease = closeWhileBlocked
        ? await this.openResult(fixture, SECOND_OPERATION)
        : undefined;
      journal.release();
      const outcome = await starting;
      const progress = await new StartupProgressDiscoveryService().read(fixture.dataDir, {
        operationId: FIRST_OPERATION,
        sequence: 0,
      });
      const acceptedCompletionPersisted =
        progress.kind === 'events' &&
        progress.events.some(
          (event) => event.phase === 'postgres-start' && event.status === 'completed',
        );
      const terminalOrReadyPersisted =
        progress.kind === 'events' &&
        progress.events.some((event) => event.status === 'failed' || event.status === 'ready');
      const closeOutcome = await closing;
      let replacementAfterRelease: PublishedControl['kind'] | undefined;
      if (ownershipReleased) {
        await ownershipReleased;
        const replacement = await this.openResult(fixture, SECOND_OPERATION);
        replacementAfterRelease = replacement.kind;
        if (replacement.kind === 'held') {
          await this.requestOwnerClose(replacement);
        }
      } else {
        await this.requestOwnerClose(owner);
      }
      return {
        outcome,
        closeOutcome,
        completion,
        ...(closeWhileBlocked
          ? {
              ownershipPendingBeforeJournalRelease,
              busyBeforeJournalRelease: busyBeforeJournalRelease?.kind,
              acceptedCompletionPersisted,
              terminalOrReadyPersisted,
              replacementAfterRelease,
            }
          : {}),
      };
    } finally {
      journal.release();
    }
  }

  async rejectsRestartAfterFailedStartupStopUntilTheChildExits() {
    const fixture = await this.fixture();
    const processes = new TrackedPostgresProcesses({
      failFirstPostgresStop: true,
    });
    this.registerProcesses(processes);
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource);
    await this.prepare(owner, 120_000);
    await writeFile(
      join(fixture.dataDir, 'postgres-password'),
      'ffffffffffffffffffffffffffffffff',
      { mode: 0o600 },
    );
    const first = await this.start(owner).then(
      () => 'resolved',
      () => 'rejected',
    );
    const repeated = await this.start(owner).then(
      () => 'resolved',
      () => 'rejected',
    );
    const startsBeforeExit = processes.postgresStarts;
    this.expectFaultInjectedStopFailure(owner);
    const closing = this.requestOwnerClose(owner).catch((error: unknown) => {
      if (!isExpectedLifecycleStopFailure(error)) {
        throw error;
      }
    });
    const busy = await this.openResult(fixture, SECOND_OPERATION);
    await processes.release();
    await closing;
    return { first, repeated, startsBeforeExit, busy: busy.kind };
  }

  async cleanup() {
    if (this.cleanupAttempt) {
      return this.cleanupAttempt;
    }
    this.closing = true;
    const attempt = this.cleanupResources();
    this.cleanupAttempt = attempt;
    void attempt.catch(() => {
      if (this.cleanupAttempt === attempt) {
        this.cleanupAttempt = undefined;
      }
    });
    return attempt;
  }

  private async fixture() {
    return this.trackAcquisition(async () => {
      const root = await mkdtemp('/tmp/pl-');
      this.roots.push(root);
      this.assertOpen();
      const dataDir = join(root, 'd');
      const runtimeDir = join(root, 'r');
      await mkdir(dataDir, { mode: 0o700 });
      this.assertOpen();
      await mkdir(runtimeDir, { mode: 0o700 });
      this.assertOpen();
      return { dataDir, logDir: join(root, 'logs'), runtimeDir };
    });
  }

  private async open(
    fixture: { dataDir: string; logDir: string; runtimeDir: string },
    operationId: string,
    allocator?: LoopbackPortAllocator,
    suppliedResource?: EmbeddedPostgresResourceService,
    journal?: StartupProgressJournalWriter,
    stopOwner = false,
  ) {
    this.diagnostics?.scenario('owner-open-requested', { operationId });
    const resource =
      suppliedResource ??
      (allocator
        ? new EmbeddedPostgresResourceService(undefined, undefined, allocator)
        : undefined);
    let owner: PublishedControl | undefined;
    owner = await this.acquireControl(
      () =>
        new PublishedControlService(
          undefined,
          undefined,
          undefined,
          undefined,
          journal,
          resource,
        ).open({
          ...fixture,
          version: '1.0.0',
          channel: 'stable',
          onStop: async (): Promise<ControlStopCompletion | undefined> => {
            if (!stopOwner || owner?.kind !== 'held') {
              return undefined;
            }
            try {
              await this.requestOwnerClose(owner);
              return { kind: 'completed' as const };
            } catch (error) {
              return {
                kind: 'failed' as const,
                ownership:
                  error instanceof PublishedControlError && error.ownership === 'retained'
                    ? ('retained' as const)
                    : ('unconfirmed' as const),
              };
            }
          },
          startupProgress: { operationId, now: () => performance.now() },
        }),
      stopOwner ? isExpectedLifecycleStopFailure : undefined,
    );
    if (owner.kind !== 'held' || !owner.startDatabase) {
      throw new Error('database owner missing');
    }
    this.diagnostics?.scenario('owner-open-resolved', { operationId, kind: owner.kind });
    return owner;
  }

  private openResult(
    fixture: { dataDir: string; logDir: string; runtimeDir: string },
    operationId: string,
  ) {
    return this.acquireControl(() =>
      new PublishedControlService().open({
        ...fixture,
        version: '1.0.0',
        channel: 'stable',
        onStop: () => undefined,
        startupProgress: { operationId, now: () => performance.now() },
      }),
    );
  }

  private async acquireEventually(
    fixture: { dataDir: string; logDir: string; runtimeDir: string },
    operationId: string,
    deadline: number,
  ): Promise<PublishedControl> {
    const owner = await this.openResult(fixture, operationId);
    if (owner.kind === 'held' || Date.now() >= deadline) {
      return owner;
    }
    return new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() =>
      this.acquireEventually(fixture, operationId, deadline),
    );
  }

  private start(owner: HeldControl, timeoutMs = 30_000, signal = new AbortController().signal) {
    const start = owner.startDatabase;
    if (!start) {
      throw new Error('database owner missing');
    }
    this.diagnostics?.scenario('start-requested', { timeoutMs });
    const operation = this.trackOperation(() => start({ signal, timeoutMs }));
    void operation.then(
      () => this.diagnostics?.scenario('start-resolved'),
      (error: unknown) =>
        this.diagnostics?.scenario('start-rejected', {
          name: describeDiagnosticError(error),
        }),
    );
    return operation;
  }

  private prepare(owner: HeldControl, timeoutMs: number) {
    const prepare = owner.prepareEmbeddedPostgres;
    if (!prepare) {
      throw new Error('embedded PostgreSQL preparation is unavailable');
    }
    const controller = new AbortController();
    const onAbort = () => this.diagnostics?.scenario('prepare-input-aborted');
    controller.signal.addEventListener('abort', onAbort, { once: true });
    this.diagnostics?.scenario('prepare-requested', {
      timeoutMs,
      inputSignalAborted: controller.signal.aborted,
    });
    const operation = this.trackOperation(() => prepare({ signal: controller.signal, timeoutMs }));
    void operation.then(
      () => this.diagnostics?.scenario('prepare-resolved'),
      (error: unknown) =>
        this.diagnostics?.scenario('prepare-rejected', {
          name: describeDiagnosticError(error),
          reason: error instanceof EmbeddedPostgresError ? error.reason : 'unknown',
          progressFailure: error instanceof EmbeddedPostgresError ? error.progressFailure : false,
          inputSignalAborted: controller.signal.aborted,
        }),
    );
    const removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort);
    void operation.then(removeAbortListener, removeAbortListener);
    return operation;
  }

  private async query(dataDir: string, port: number, statements: readonly string[]) {
    return this.trackOperation(async () => {
      const client = new Client({
        host: '127.0.0.1',
        port,
        user: 'postgres',
        password: await readFile(join(dataDir, 'postgres-password'), 'utf8'),
        database: 'revo',
        ssl: false,
      });
      let result: unknown[] = [];
      let failure: unknown;
      try {
        await client.connect();
        result = await statements.reduce<Promise<unknown[]>>(async (previous, statement) => {
          await previous;
          return (await client.query(statement)).rows;
        }, Promise.resolve([]));
      } catch (error) {
        failure = error;
      }
      try {
        await client.end();
      } catch (cleanupError) {
        failure =
          failure === undefined
            ? cleanupError
            : new AggregateError(
                [failure, cleanupError],
                'PostgreSQL client query and cleanup failed',
                {
                  cause: failure,
                },
              );
      }
      if (failure !== undefined) {
        throw failure;
      }
      return result;
    });
  }

  private async cleanupResources() {
    this.diagnostics?.scenario('cleanup-started', this.cleanupCounts());
    try {
      await this.cleanupResourcesBody();
    } catch (error) {
      this.diagnostics?.scenario('cleanup-failed', {
        ...this.cleanupCounts(),
        phase: 'cleanup',
        ownership: this.owners.length === 0 ? 'released' : 'retained',
        cleanupFailures: describeDiagnosticFailures(error),
      });
      if (this.diagnostics) {
        await this.diagnostics.waitForStderr(250);
        console.error(this.diagnostics.formatReport('cleanup-failed', error));
      }
      throw error;
    }
  }

  private async cleanupResourcesBody() {
    const deadline = Date.now() + LIFECYCLE_CLEANUP_OBSERVATION_MS;
    const failures: unknown[] = [];
    const addFailure = (error: unknown) => {
      if (error instanceof AggregateError && error.errors.length > 0) {
        for (const nested of error.errors) {
          addFailure(nested);
        }
      } else if (!failures.includes(error)) {
        failures.push(error);
      }
    };
    const recordOperation = async (operation: Promise<unknown>) => {
      try {
        await operation;
      } catch (error) {
        addFailure(error);
      }
    };

    await recordOperation(this.runBeforeCloseActions(deadline));
    for (const processes of this.processes) {
      processes.closeAdmission();
    }
    const ownersAtCleanupStart = new Set(this.owners);
    await recordOperation(
      cleanupRegistered(this.owners, (owner) =>
        this.closeTrackedOwner(owner, this.remaining(deadline)),
      ),
    );
    await recordOperation(this.drainOperations(this.acquisitions, deadline));
    await recordOperation(this.drainOperations(this.operations, deadline));
    const lateOwners = this.owners.filter((owner) => !ownersAtCleanupStart.has(owner));
    if (lateOwners.length > 0) {
      const lateCloseResults = await Promise.allSettled(
        lateOwners.map(async (owner) => {
          await this.closeTrackedOwner(owner, this.remaining(deadline));
          const index = this.owners.indexOf(owner);
          if (index !== -1) {
            this.owners.splice(index, 1);
          }
        }),
      );
      const lateCloseFailures = lateCloseResults.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      lateCloseFailures.forEach(addFailure);
    }
    await recordOperation(
      cleanupRegistered(this.processes, (processes) => {
        this.diagnostics?.scenario('process-drain-started', this.cleanupCounts());
        return observeFixtureCleanup(processes.drain(), this.remaining(deadline));
      }),
    );

    if (
      this.owners.length === 0 &&
      this.acquisitions.size === 0 &&
      this.operations.size === 0 &&
      this.processes.length === 0
    ) {
      await recordOperation(
        cleanupRegistered(this.allocators, (allocator) =>
          this.closeAllocator(allocator, this.remaining(deadline)),
        ),
      );
    } else if (failures.length === 0) {
      addFailure(new Error('Lifecycle fixture ownership remains unconfirmed; roots retained'));
    }

    for (const error of this.acquisitionFailures) {
      addFailure(error);
    }
    for (const errors of this.allocatorFailures.values()) {
      for (const error of errors) {
        addFailure(error);
      }
    }
    for (const owner of this.owners) {
      const record = this.ownerRecords.get(owner);
      if (record) {
        for (const error of record.closeFailures) {
          if (!this.isExpectedCloseFailure(record, error)) {
            addFailure(error);
          }
        }
        for (const error of record.releaseFailures) {
          addFailure(error);
        }
      }
    }
    for (const action of this.beforeCloseActions.values()) {
      if (action.error !== undefined) {
        addFailure(action.error);
      }
    }

    if (
      failures.length > 0 ||
      this.owners.length > 0 ||
      this.acquisitions.size > 0 ||
      this.operations.size > 0 ||
      this.allocators.length > 0 ||
      this.processes.length > 0 ||
      this.beforeCloseActions.size > 0
    ) {
      throw new AggregateError(failures, 'Lifecycle fixture cleanup unconfirmed; roots retained');
    }

    await cleanupRegistered(this.roots, (root) => rm(root, { recursive: true, force: true }));
    this.diagnostics?.scenario('cleanup-finished', {
      ...this.cleanupCounts(),
      rootsRemoved: true,
    });
    if (this.diagnostics) {
      await this.diagnostics.waitForStderr(250);
      console.error(this.diagnostics.formatReport('cleanup-finished'));
    }
  }

  private async drainOperations(operations: Set<Promise<unknown>>, deadline: number) {
    const snapshot = [...operations];
    if (snapshot.length === 0) {
      return;
    }
    await observeFixtureCleanup(
      Promise.allSettled(snapshot).then(() => undefined),
      this.remaining(deadline),
    );
  }

  private async runBeforeCloseActions(deadline: number) {
    const outcomes = await Promise.allSettled(
      [...this.beforeCloseActions.keys()].map((action) =>
        observeFixtureCleanup(this.runBeforeCloseAction(action), this.remaining(deadline)),
      ),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Lifecycle fixture finalizers did not settle safely');
    }
  }

  private runBeforeCloseAction(action: () => void | Promise<void>) {
    const record = this.beforeCloseActions.get(action);
    if (!record) {
      throw new Error('Lifecycle fixture finalizer is not registered');
    }
    if (!record.promise) {
      const operation = Promise.resolve().then(action);
      record.promise = operation;
      void operation.then(
        () => this.beforeCloseActions.delete(action),
        (error: unknown) => {
          record.error = error;
        },
      );
      void operation.catch(() => undefined);
    }
    return record.promise;
  }

  private registerBeforeClose(action: () => void | Promise<void>) {
    this.beforeCloseActions.set(action, {});
  }

  private registerProcesses(processes: TrackedPostgresProcesses) {
    if (!this.processes.includes(processes)) {
      this.processes.push(processes);
    }
  }

  private registerAllocator(allocator: CloseableAllocator) {
    if (!this.allocators.includes(allocator)) {
      this.allocators.push(allocator);
      this.allocatorFailures.set(allocator, new Set());
    }
  }

  private async closeAllocator(allocator: CloseableAllocator, timeoutMs: number) {
    this.diagnostics?.scenario('allocator-close-requested');
    let operation = this.allocatorOperations.get(allocator);
    if (!operation || operation.state !== 'pending') {
      operation = this.trackCloseOperation(
        () => allocator.close(),
        (failure) => {
          this.allocatorFailures.get(allocator)?.add(failure);
        },
      );
      this.allocatorOperations.set(allocator, operation);
    }
    try {
      await observeFixtureCleanup(operation.promise, timeoutMs);
      this.diagnostics?.scenario('allocator-close-resolved');
    } catch (error) {
      this.diagnostics?.scenario('allocator-close-rejected', {
        error: describeDiagnosticError(error),
      });
      throw error;
    }
    const failures = this.allocatorFailures.get(allocator);
    if (failures && failures.size > 0) {
      throw new AggregateError([...failures], 'Lifecycle allocator close failed');
    }
  }

  private async acquireControl(
    acquire: () => Promise<PublishedControl>,
    expectedCloseFailure?: (error: unknown) => boolean,
  ) {
    return this.trackAcquisition(async () => {
      const owner = await acquire();
      if (owner.kind === 'held') {
        this.registerOwner(owner, expectedCloseFailure);
      }
      if (this.closing) {
        if (owner.kind === 'held') {
          await this.closeTrackedOwner(owner, LIFECYCLE_CLEANUP_OBSERVATION_MS);
        } else {
          this.acquisitionFailures.add(
            new Error('Late lifecycle acquisition found an unowned busy fixture'),
          );
        }
        throw new LifecycleScenarioClosingError();
      }
      return owner;
    });
  }

  private registerOwner(owner: HeldControl, expectedCloseFailure?: (error: unknown) => boolean) {
    if (!this.ownerRecords.has(owner)) {
      this.ownerRecords.set(owner, {
        closeOperations: [],
        closeFailures: new Set(),
        releaseFailures: new Set(),
        expectedCloseFailure: expectedCloseFailure ?? (() => false),
      });
      this.owners.push(owner);
      return;
    }
    if (expectedCloseFailure) {
      const record = this.ownerRecords.get(owner);
      if (record) {
        record.expectedCloseFailure = expectedCloseFailure;
      }
    }
  }

  private requestOwnerClose(owner: HeldControl, coalescePending = false) {
    const record = this.ownerRecords.get(owner);
    if (!record || !this.owners.includes(owner)) {
      throw new Error('Lifecycle owner is not registered');
    }
    if (coalescePending) {
      const pending = record.closeOperations.find((operation) => operation.state === 'pending');
      if (pending) {
        return pending.promise;
      }
    }
    const operation = this.trackCloseOperation(
      () => owner.close(),
      (failure) => {
        record.closeFailures.add(failure);
      },
    );
    record.closeOperations.push(operation);
    this.diagnostics?.scenario('owner-close-requested', {
      coalescePending,
    });
    void operation.promise.then(
      () => this.diagnostics?.scenario('owner-close-resolved'),
      (error: unknown) =>
        this.diagnostics?.scenario('owner-close-rejected', {
          error: describeDiagnosticError(error),
        }),
    );
    return operation.promise;
  }

  private ownerRelease(owner: HeldControl) {
    const record = this.ownerRecords.get(owner);
    if (!record) {
      throw new Error('Lifecycle owner is not registered');
    }
    if (!record.releaseOperation) {
      const operation = this.trackCloseOperation(
        () => owner.ownershipReleased(),
        (failure) => {
          record.releaseFailures.add(failure);
        },
      );
      record.releaseOperation = operation.promise;
      this.diagnostics?.scenario('owner-release-requested');
      void operation.promise.then(
        () => this.diagnostics?.scenario('owner-release-resolved'),
        (error: unknown) =>
          this.diagnostics?.scenario('owner-release-rejected', {
            error: describeDiagnosticError(error),
          }),
      );
    }
    return record.releaseOperation;
  }

  private async closeTrackedOwner(owner: HeldControl, timeoutMs: number) {
    const record = this.ownerRecords.get(owner);
    if (!record) {
      throw new Error('Lifecycle owner is not registered');
    }
    const observedOwner = {
      close: () => this.requestOwnerClose(owner, true),
      ownershipReleased: () => this.ownerRelease(owner),
    };
    try {
      await closeFixtureOwner(
        observedOwner,
        (error) => this.isExpectedCloseFailure(record, error),
        timeoutMs,
      );
    } catch (error) {
      this.diagnostics?.scenario('owner-cleanup-rejected', {
        phase: 'owner-close-or-release',
        ownership: record.releaseFailures.size > 0 ? 'unconfirmed' : 'retained',
        cleanupFailures: describeDiagnosticFailures(error),
      });
      throw error;
    }
    this.diagnostics?.scenario('owner-cleanup-resolved', { ownership: 'released' });
    const unexpected = [...record.closeFailures].filter(
      (error) => !this.isExpectedCloseFailure(record, error),
    );
    if (unexpected.length > 0) {
      throw new AggregateError(unexpected, 'Lifecycle owner close failed after release');
    }
    if (record.releaseFailures.size > 0) {
      throw new AggregateError([...record.releaseFailures], 'Lifecycle owner release failed');
    }
  }

  private expectFaultInjectedStopFailure(owner: HeldControl) {
    const record = this.ownerRecords.get(owner);
    if (record) {
      record.expectedCloseFailure = isExpectedLifecycleStopFailure;
    }
  }

  private isExpectedCloseFailure(record: OwnerCleanupRecord, error: unknown) {
    try {
      return record.expectedCloseFailure(error);
    } catch {
      return false;
    }
  }

  private trackAcquisition<T>(acquire: () => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(new LifecycleScenarioClosingError());
    }
    const operation = Promise.resolve().then(() => {
      this.assertOpen();
      return acquire();
    });
    this.acquisitions.add(operation);
    void operation.then(
      () => this.acquisitions.delete(operation),
      (error: unknown) => {
        this.acquisitions.delete(operation);
        if (
          this.closing &&
          !(error instanceof LifecycleScenarioClosingError) &&
          !(error instanceof PublishedControlError && error.ownership === 'released')
        ) {
          this.acquisitionFailures.add(error);
        }
      },
    );
    void operation.catch(() => undefined);
    return operation;
  }

  private trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(new LifecycleScenarioClosingError());
    }
    const pending = Promise.resolve().then(() => {
      this.assertOpen();
      return operation();
    });
    this.operations.add(pending);
    void pending.then(
      () => this.operations.delete(pending),
      () => this.operations.delete(pending),
    );
    void pending.catch(() => undefined);
    return pending;
  }

  private trackCloseOperation(
    operation: () => Promise<void>,
    onRejected: (error: unknown) => void,
  ): TrackedCloseOperation {
    const tracked: TrackedCloseOperation = {
      promise: Promise.resolve().then(operation),
      state: 'pending',
    };
    void tracked.promise.then(
      () => {
        tracked.state = 'fulfilled';
      },
      (error: unknown) => {
        tracked.state = 'rejected';
        tracked.error = error;
        onRejected(error);
      },
    );
    void tracked.promise.catch(() => undefined);
    return tracked;
  }

  private assertOpen() {
    if (this.closing) {
      throw new LifecycleScenarioClosingError();
    }
  }

  private remaining(deadline: number) {
    return Math.max(0, deadline - Date.now());
  }

  private cleanupCounts() {
    return {
      owners: this.owners.length,
      acquisitions: this.acquisitions.size,
      operations: this.operations.size,
      allocators: this.allocators.length,
      processes: this.processes.length,
      roots: this.roots.length,
      beforeCloseActions: this.beforeCloseActions.size,
    } as const;
  }
}

class PausedSpawnProcesses extends TrackedPostgresProcesses {
  cancellationPolicy: { readonly graceMs: number; readonly killWaitMs: number } | undefined;
  private releaseSpawn!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseSpawn = resolve;
  });
  private announce!: () => void;
  readonly spawned = new Promise<void>((resolve) => {
    this.announce = resolve;
  });

  constructor(
    private readonly diagnostics?: PostgresProcessDiagnosticCollector,
    options: { readonly postmasterPidAfterExit?: 'file' | 'symlink' } = {},
  ) {
    super({
      owner: 'cancel-before-readiness',
      ...options,
      ...(diagnostics ? { diagnostics } : {}),
    });
  }

  override async start(request: ManagedProcessRequest) {
    const process = await super.start(request);
    if (request.args[0] === '-D') {
      this.completion = process.completion;
      if (request.cancellation) {
        this.cancellationPolicy = {
          graceMs: request.cancellation.graceMs,
          killWaitMs: request.cancellation.killWaitMs,
        };
      }
      this.diagnostics?.scenario('postgres-spawn-gate-announced');
      this.announce();
      this.diagnostics?.scenario('postgres-spawn-gate-wait-started');
      await this.gate;
      this.diagnostics?.scenario('postgres-spawn-gate-released');
    }
    this.diagnostics?.scenario('postgres-start-handle-returning');
    return process;
  }

  continue(source: 'after-explicit-abort' | 'scenario-finally' | 'before-close') {
    this.diagnostics?.scenario('spawn-gate-release-requested', { source });
    this.releaseSpawn();
  }
}

class ContendedPortAllocator extends LoopbackPortAllocator {
  readonly ports: number[] = [];
  previousExited = true;
  private readonly listeners: Server[] = [];
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly processes: TrackedPostgresProcesses,
    private readonly conflicts: number,
    private readonly diagnostics?: PostgresProcessDiagnosticCollector,
  ) {
    super();
  }

  override async reserve(): Promise<ReservedLoopbackPort> {
    const attempt = this.ports.length + 1;
    this.diagnostics?.scenario('allocator-reservation-requested', {
      attempt,
      previousExited: this.previousExited,
    });
    if (this.ports.length > 0) {
      this.previousExited &&= this.processes.completedPostgres >= this.ports.length;
      this.diagnostics?.scenario('allocator-before-next-reserve', {
        attempt,
        completedPostgres: this.processes.completedPostgres,
        previousExited: this.previousExited,
      });
    }
    const reservation = await super.reserve();
    const attemptNumber = this.ports.push(reservation.port);
    this.diagnostics?.scenario('allocator-reservation-resolved', {
      attempt: attemptNumber,
      port: reservation.port,
    });
    return {
      port: reservation.port,
      release: async () => {
        this.diagnostics?.scenario('allocator-reservation-release-requested', {
          attempt: attemptNumber,
          port: reservation.port,
        });
        try {
          await reservation.release();
        } catch (error) {
          this.diagnostics?.scenario('allocator-reservation-release-rejected', {
            attempt: attemptNumber,
            error: describeDiagnosticError(error),
          });
          throw error;
        }
        if (attempt <= this.conflicts) {
          const listener = createServer((socket) => {
            this.sockets.add(socket);
            socket.once('close', () => this.sockets.delete(socket));
            socket.once('data', () => socket.end('foreign-listener'));
          });
          this.listeners.push(listener);
          await new Promise<void>((resolve, reject) => {
            listener.once('error', reject);
            listener.listen(
              { host: '127.0.0.1', port: reservation.port, exclusive: true },
              resolve,
            );
          });
          this.diagnostics?.scenario('foreign-listener-ready', {
            attempt: attemptNumber,
            port: reservation.port,
          });
        } else {
          this.diagnostics?.scenario('allocator-reservation-released', {
            attempt: attemptNumber,
            port: reservation.port,
          });
        }
      },
    };
  }

  inspectListeners() {
    return Promise.all(this.listeners.map((_listener, index) => readListener(this.ports[index])));
  }

  async close() {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await Promise.all(
      this.listeners.map(
        (listener) =>
          new Promise<void>((resolve, reject) =>
            listener.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
    this.diagnostics?.scenario('allocator-closed', {
      listeners: this.listeners.length,
    });
  }
}

class ForeignPostgresAllocator extends LoopbackPortAllocator {
  ownedAttempts = 0;
  foreignPort: number | undefined;
  private foreign: ClusterFixture | undefined;

  override async reserve() {
    const reservation = await super.reserve();
    this.ownedAttempts += 1;
    return {
      port: reservation.port,
      release: async () => {
        await reservation.release();
        if (!this.foreign) {
          this.foreignPort = reservation.port;
          this.foreign = ClusterFixture.create('trust', reservation.port);
          await this.foreign.start();
        }
      },
    };
  }

  async inspect() {
    if (!this.foreign) {
      throw new Error('foreign PostgreSQL missing');
    }
    return {
      reachable: await this.foreign.isAlive(),
      databaseCreated: await this.foreign.databaseExists(),
    };
  }

  async close() {
    if (this.foreign) {
      await this.foreign.close();
    }
  }
}

class GatedReleaseAllocator extends LoopbackPortAllocator {
  private releaseGate!: () => void;
  private notifyReleasing!: () => void;
  readonly releasing = new Promise<void>((resolve) => (this.notifyReleasing = resolve));
  private readonly gate = new Promise<void>((resolve) => (this.releaseGate = resolve));

  override async reserve() {
    const reservation = await super.reserve();
    return {
      port: reservation.port,
      release: async () => {
        await reservation.release();
        this.notifyReleasing();
        await this.gate;
      },
    };
  }

  continue() {
    this.releaseGate();
  }

  async close() {
    this.continue();
  }
}

const readListener = (port: number | undefined) =>
  new Promise<string>((resolve, reject) => {
    if (port === undefined) {
      reject(new Error('listener port missing'));
      return;
    }
    const socket = createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(1000, () => socket.destroy(new Error('listener timed out')));
    socket.once('connect', () => socket.write('probe'));
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.once('error', reject);
    socket.once('close', () => resolve(response));
  });

const toOutcome = () => 'resolved' as const;
const toRejectedOutcome = () => 'rejected' as const;
const toDiagnosticRejectedOutcome = (error: unknown) =>
  error instanceof EmbeddedPostgresError
    ? {
        kind: 'rejected' as const,
        reason: error.reason,
        progressFailure: error.progressFailure,
        observedCompletion: error.observedCompletion,
      }
    : { kind: 'rejected' as const };

const describeDiagnosticError = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const describeDiagnosticFailures = (error: unknown) => {
  if (error instanceof AggregateError) {
    return error.errors.slice(0, 16).map(describeDiagnosticError);
  }
  return [describeDiagnosticError(error)];
};
const waitForGate = async (
  gate: Promise<void>,
  outcome: Promise<unknown>,
  timeoutMs = 5_000,
): Promise<void> => {
  const reached = await Promise.race([
    gate.then(() => 'gate' as const),
    outcome?.then(() => 'outcome' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ]);
  if (reached !== 'gate') {
    throw new Error(`fixture gate was not reached: ${reached}`);
  }
};
const isOwnedStartupProgressClose = (
  value: unknown,
): value is (this: OwnedStartupProgress) => Promise<void> => typeof value === 'function';
