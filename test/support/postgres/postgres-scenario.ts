import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { EmbeddedPostgresPreparationService } from '../../../src/postgres/embedded-postgres-preparation.service.js';
import { EmbeddedPostgresResourceService } from '../../../src/postgres/embedded-postgres-resource.service.js';
import { EmbeddedPostgresError } from '../../../src/postgres/embedded-postgres.types.js';
import { ManagedProcessError } from '../../../src/processes/managed-process-error.js';
import { ManagedProcessService } from '../../../src/processes/managed-process.service.js';
import type {
  ManagedProcessRequest,
  OwnedProcess,
  ProcessCancellationResult,
  ProcessCompletion,
} from '../../../src/processes/managed-process.types.js';
import {
  PublishedControlError,
  PublishedControlService,
} from '../../../src/processes/published-control.service.js';
import { StartupProgressJournalWriter } from '../../../src/startup-progress/startup-progress-journal.service.js';
import { BlockingJournal } from '../startup-progress/blocking-journal.js';
import {
  ProvisionFixtureLifetime,
  type ProvisionFixtureLifetimeScope,
} from './provision-fixture-lifetime.js';

const operationId = '1234567890abcdef1234567890abcdef';

export class PostgresScenario {
  private readonly lifetime = new ProvisionFixtureLifetime();

  provisionAndReopen() {
    const scope = this.lifetime.scope();
    return scope.run(() => this.provisionAndReopenIn(scope));
  }

  private async provisionAndReopenIn(scope: ProvisionFixtureLifetimeScope) {
    const fixture = await this.fixture(scope);
    const first = await this.open(scope, fixture);
    if (first.kind !== 'held' || !first.prepareEmbeddedPostgres) {
      throw new Error('owner missing');
    }
    const [left, right] = await Promise.all([
      first.prepareEmbeddedPostgres({ signal: new AbortController().signal, timeoutMs: 60_000 }),
      first.prepareEmbeddedPostgres({ signal: new AbortController().signal, timeoutMs: 60_000 }),
    ]);
    const passwordPath = join(fixture.dataDir, 'postgres-password');
    const before = await readFile(passwordPath, 'utf8');
    await scope.closeOwner(first);
    const second = await this.open(scope, fixture);
    if (second.kind !== 'held' || !second.prepareEmbeddedPostgres) {
      throw new Error('owner missing');
    }
    const reopened = await second.prepareEmbeddedPostgres({
      signal: new AbortController().signal,
      timeoutMs: 60_000,
    });
    const after = await readFile(passwordPath, 'utf8');
    await scope.closeOwner(second);
    return {
      samePromiseResult: left.clusterDir === right.clusterDir,
      created: left.created,
      reopened: reopened.created,
      passwordPreserved: before === after,
      passwordMode: (await lstat(passwordPath)).mode & 0o777,
      version: await readFile(join(left.clusterDir, 'PG_VERSION'), 'utf8'),
      frozen: Object.isFrozen(left),
    };
  }

  rejectsUnsafeExistingState(
    kind:
      | 'fifo'
      | 'malformed-credential'
      | 'partial'
      | 'public-credential'
      | 'symlink'
      | 'wrong-major',
  ) {
    const scope = this.lifetime.scope();
    return scope.run(() => this.rejectsUnsafeExistingStateIn(scope, kind));
  }

  private async rejectsUnsafeExistingStateIn(
    scope: ProvisionFixtureLifetimeScope,
    kind:
      | 'fifo'
      | 'malformed-credential'
      | 'partial'
      | 'public-credential'
      | 'symlink'
      | 'wrong-major',
  ) {
    const fixture = await this.fixture(scope);
    const credentialPath = join(fixture.dataDir, 'postgres-password');
    if (['malformed-credential', 'public-credential', 'wrong-major'].includes(kind)) {
      const seeded = await this.open(scope, fixture);
      if (seeded.kind !== 'held' || !seeded.prepareEmbeddedPostgres) {
        throw new Error('owner missing');
      }
      await seeded.prepareEmbeddedPostgres({
        signal: new AbortController().signal,
        timeoutMs: 60_000,
      });
      await scope.closeOwner(seeded);
    } else {
      await mkdir(join(fixture.dataDir, 'postgres'), { mode: 0o700 });
    }
    if (kind === 'fifo') {
      await promisify(execFile)('mkfifo', [join(fixture.dataDir, 'postgres-password')]);
    } else if (kind === 'partial') {
      await writeFile(credentialPath, 'existing', { mode: 0o600 });
    } else if (kind === 'symlink') {
      await symlink(join(fixture.dataDir, 'target'), join(fixture.dataDir, 'postgres-password'));
    } else {
      if (kind === 'malformed-credential') {
        await writeFile(credentialPath, 'existing');
      }
      if (kind === 'public-credential') {
        await chmod(credentialPath, 0o644);
      }
      if (kind === 'wrong-major') {
        await writeFile(join(fixture.dataDir, 'postgres', 'PG_VERSION'), '16\n');
      }
    }
    const held = await this.open(scope, fixture);
    if (held.kind !== 'held' || !held.prepareEmbeddedPostgres || !held.progress) {
      throw new Error('owner missing');
    }
    const outcome = await held
      .prepareEmbeddedPostgres({ signal: new AbortController().signal, timeoutMs: 1000 })
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    await scope.closeOwner(held);
    return outcome;
  }

  closeCancelsOwnedInitialization() {
    const scope = this.lifetime.scope();
    return scope.run(() => this.closeCancelsOwnedInitializationIn(scope));
  }

  private async closeCancelsOwnedInitializationIn(scope: ProvisionFixtureLifetimeScope) {
    const fixture = await this.fixture(scope);
    const process = new FailingCancellationProcess();
    const journal = new BlockingJournal();
    scope.beforeClose(async () => {
      const failures: unknown[] = [];
      try {
        journal.release();
      } catch (error) {
        failures.push(error);
      }
      try {
        await process.exit();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Provision child finalization failed');
      }
    });
    const held = await this.open(
      scope,
      fixture,
      new EmbeddedPostgresPreparationService(process),
      journal,
      (error) =>
        error instanceof PublishedControlError &&
        error.phase === 'close' &&
        error.cleanupFailures.length === 0 &&
        error.ownership === 'retained',
    );
    if (held.kind !== 'held' || !held.prepareEmbeddedPostgres || !held.progress) {
      throw new Error('owner missing');
    }
    const preparation = scope.observe(
      held.prepareEmbeddedPostgres({
        signal: new AbortController().signal,
        timeoutMs: 60_000,
      }),
    );
    await process.started;
    const coalesced = scope.observe(
      held.prepareEmbeddedPostgres({
        signal: new AbortController().signal,
        timeoutMs: 60_000,
      }),
    );
    journal.blockNext();
    const pendingProgress = scope.observe(held.progress.progress('postgres-initialization'));
    await journal.entered;
    const firstClosePending = scope.observe(
      scope.requestOwnerClose(held).then(
        () => 'resolved',
        (error: unknown) => closeFailure(error),
      ),
    );
    const secondClose = await Promise.race([
      scope.requestOwnerClose(held).then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);
    const busy = await this.open(scope, fixture);
    await process.exit();
    await scope.observe(process.exited);
    const beforeDrain = await this.open(scope, fixture);
    const beforeDrainClose = await Promise.race([
      scope.requestOwnerClose(held).then(
        () => 'resolved' as const,
        (error: unknown) => closeFailure(error),
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);
    journal.release();
    await pendingProgress;
    const firstClose = await firstClosePending;
    const outcome = await preparation.then(
      () => 'resolved',
      () => 'rejected',
    );
    const replacement = await this.acquireEventually(scope, fixture);
    if (replacement.kind !== 'held') {
      throw new Error('replacement owner missing');
    }
    const oldClose = await scope.requestOwnerClose(held).then(() => 'resolved' as const);
    const successorStillHeld = await this.open(scope, fixture);
    const retained = await Promise.all([
      lstat(join(fixture.dataDir, 'postgres')).then(
        () => true,
        () => false,
      ),
      lstat(join(fixture.dataDir, 'postgres-password')).then(
        () => true,
        () => false,
      ),
    ]);
    await scope.closeOwner(replacement);
    return {
      firstClose,
      secondClose,
      outcome,
      coalesced: coalesced === preparation,
      busy: busy.kind,
      beforeDrain: beforeDrain.kind,
      beforeDrainClose,
      replacement: replacement.kind,
      oldClose,
      successorStillHeld: successorStillHeld.kind,
      retained,
      secretByPathOnly: process.request?.args.some((value) => value.includes('--pwfile=')),
      environment: process.request?.env,
    };
  }

  preservesObservedInitializationExitWhenProgressFailureRewraps() {
    const scope = this.lifetime.scope();
    return scope.run(() =>
      this.preservesObservedInitializationExitWhenProgressFailureRewrapsIn(scope),
    );
  }

  private async preservesObservedInitializationExitWhenProgressFailureRewrapsIn(
    scope: ProvisionFixtureLifetimeScope,
  ) {
    const fixture = await this.fixture(scope);
    const held = await this.open(
      scope,
      fixture,
      new EmbeddedPostgresPreparationService(new ImmediateFailedProcess()),
      new FailedProgressJournal(),
    );
    if (held.kind !== 'held' || !held.prepareEmbeddedPostgres) {
      throw new Error('owner missing');
    }
    return held
      .prepareEmbeddedPostgres({ signal: new AbortController().signal, timeoutMs: 1000 })
      .then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) =>
          error instanceof EmbeddedPostgresError
            ? {
                kind: 'rejected' as const,
                reason: error.reason,
                progressFailure: error.progressFailure,
                observedCompletion: error.observedCompletion,
              }
            : { kind: 'unexpected' as const },
      );
  }

  async cleanup() {
    await this.lifetime.cleanup();
  }

  private fixture(scope: ProvisionFixtureLifetimeScope) {
    return scope.create(async (registerRoot) => {
      const root = await mkdtemp('/tmp/pg-');
      registerRoot(root);
      const dataDir = join(root, 'data');
      const runtimeDir = join(root, 'run');
      await mkdir(dataDir, { mode: 0o700 });
      await mkdir(runtimeDir, { mode: 0o700 });
      await chmod(dataDir, 0o700);
      await chmod(runtimeDir, 0o700);
      return { root, dataDir, logDir: join(root, 'logs'), runtimeDir };
    });
  }

  private open(
    scope: ProvisionFixtureLifetimeScope,
    fixture: { dataDir: string; logDir: string; runtimeDir: string },
    postgres?: EmbeddedPostgresPreparationService,
    journal?: StartupProgressJournalWriter,
    expectedCloseFailure: (error: unknown) => boolean = () => false,
  ) {
    const resource = postgres ? new EmbeddedPostgresResourceService(postgres) : undefined;
    return scope.acquire(
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
          onStop: () => undefined,
          startupProgress: { operationId, now: () => performance.now() },
        }),
      (candidate) => (candidate.kind === 'held' ? candidate : undefined),
      (candidate) => candidate.kind === 'busy',
      expectedCloseFailure,
    );
  }

  private acquireEventually(
    scope: ProvisionFixtureLifetimeScope,
    fixture: { dataDir: string; logDir: string; runtimeDir: string },
    deadline = Date.now() + 1000,
  ): ReturnType<PostgresScenario['open']> {
    return this.open(scope, fixture).then((candidate) => {
      if (candidate.kind === 'held' || Date.now() >= deadline) {
        return candidate;
      }
      return new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
        this.acquireEventually(scope, fixture, deadline),
      );
    });
  }
}

function closeFailure(error: unknown) {
  return error instanceof PublishedControlError
    ? { status: 'rejected' as const, code: error.code, ownership: error.ownership }
    : { status: 'rejected' as const, code: 'unexpected', ownership: 'unconfirmed' as const };
}

export class FailingCancellationProcess extends ManagedProcessService {
  request: ManagedProcessRequest | undefined;
  private owned: OwnedProcess | undefined;
  private startPromise: Promise<OwnedProcess> | undefined;
  private exitPromise: Promise<void> | undefined;
  private exitRequested = false;
  private notifyStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.notifyStarted = resolve;
  });
  exited!: Promise<ProcessCompletion>;

  override start(request: ManagedProcessRequest): Promise<OwnedProcess> {
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.exitRequested) {
      return Promise.reject(new Error('process is closing'));
    }
    this.request = request;
    const { cancellation: _cancellation, ...processRequest } = request;
    let resolveCancellation!: (result: ProcessCancellationResult) => void;
    const cancellationResult = new Promise<ProcessCancellationResult>((resolve) => {
      resolveCancellation = resolve;
    });
    const signal = request.cancellation?.signal;
    const onAbort = () =>
      resolveCancellation({
        kind: 'failed',
        error: new ManagedProcessError(
          'revo.process.stop-timeout',
          'Managed process did not exit.',
        ),
      });
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }
    void cancellationResult.then(() => signal?.removeEventListener('abort', onAbort));

    const starting = super
      .start({
        ...processRequest,
        executable: process.execPath,
        args: ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      })
      .then((owned) => {
        this.owned = owned;
        this.exited = owned.completion;
        this.notifyStarted();
        return { completion: this.exited, cancellationResult };
      });
    this.startPromise = starting;
    return starting;
  }

  exit(): Promise<void> {
    this.exitRequested = true;
    if (!this.startPromise) {
      return Promise.resolve();
    }
    this.exitPromise ??= this.startPromise.then(
      () => (this.owned ? this.stop(this.owned, { graceMs: 0, killWaitMs: 5000 }) : undefined),
      () => undefined,
    );
    return this.exitPromise;
  }
}

class ImmediateFailedProcess extends ManagedProcessService {
  override async start(): Promise<OwnedProcess> {
    return { completion: Promise.resolve({ exitCode: 7, signal: null }) };
  }
}

class FailedProgressJournal extends StartupProgressJournalWriter {
  override async write(...parameters: Parameters<StartupProgressJournalWriter['write']>) {
    if (parameters[2].at(-1)?.status === 'failed') {
      throw new Error('secret progress write failure');
    }
    return super.write(...parameters);
  }
}
