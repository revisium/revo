import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { EmbeddedPostgresPreparationService } from '../../../src/postgres/embedded-postgres-preparation.service.js';
import { EmbeddedPostgresResourceService } from '../../../src/postgres/embedded-postgres-resource.service.js';
import { ManagedProcessError } from '../../../src/processes/managed-process-error.js';
import { ManagedProcessService } from '../../../src/processes/managed-process.service.js';
import type {
  ManagedProcessRequest,
  OwnedProcess,
  ProcessCancellationResult,
  ProcessCompletion,
} from '../../../src/processes/managed-process.types.js';
import { PublishedControlService } from '../../../src/processes/published-control.service.js';
import { StartupProgressJournalWriter } from '../../../src/startup-progress/startup-progress-journal.service.js';
import { BlockingJournal } from '../startup-progress/blocking-journal.js';

const operationId = '1234567890abcdef1234567890abcdef';

export class PostgresScenario {
  private readonly roots: string[] = [];

  async provisionAndReopen() {
    const fixture = await this.fixture();
    const first = await this.open(fixture);
    if (first.kind !== 'held' || !first.prepareEmbeddedPostgres) {
      throw new Error('owner missing');
    }
    const [left, right] = await Promise.all([
      first.prepareEmbeddedPostgres({ signal: new AbortController().signal, timeoutMs: 60_000 }),
      first.prepareEmbeddedPostgres({ signal: new AbortController().signal, timeoutMs: 60_000 }),
    ]);
    const passwordPath = join(fixture.dataDir, 'postgres-password');
    const before = await readFile(passwordPath, 'utf8');
    await first.close();
    const second = await this.open(fixture);
    if (second.kind !== 'held' || !second.prepareEmbeddedPostgres) {
      throw new Error('owner missing');
    }
    const reopened = await second.prepareEmbeddedPostgres({
      signal: new AbortController().signal,
      timeoutMs: 60_000,
    });
    const after = await readFile(passwordPath, 'utf8');
    await second.close();
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

  async rejectsUnsafeExistingState(
    kind:
      | 'fifo'
      | 'malformed-credential'
      | 'partial'
      | 'public-credential'
      | 'symlink'
      | 'wrong-major',
  ) {
    const fixture = await this.fixture();
    const credentialPath = join(fixture.dataDir, 'postgres-password');
    if (['malformed-credential', 'public-credential', 'wrong-major'].includes(kind)) {
      const seeded = await this.open(fixture);
      if (seeded.kind !== 'held' || !seeded.prepareEmbeddedPostgres) {
        throw new Error('owner missing');
      }
      await seeded.prepareEmbeddedPostgres({
        signal: new AbortController().signal,
        timeoutMs: 60_000,
      });
      await seeded.close();
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
    const held = await this.open(fixture);
    if (held.kind !== 'held' || !held.prepareEmbeddedPostgres || !held.progress) {
      throw new Error('owner missing');
    }
    const outcome = await held
      .prepareEmbeddedPostgres({ signal: new AbortController().signal, timeoutMs: 1000 })
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    await held.close();
    return outcome;
  }

  async closeCancelsOwnedInitialization() {
    const fixture = await this.fixture();
    const process = new FailingCancellationProcess();
    const journal = new BlockingJournal();
    const held = await this.open(fixture, new EmbeddedPostgresPreparationService(process), journal);
    if (held.kind !== 'held' || !held.prepareEmbeddedPostgres || !held.progress) {
      throw new Error('owner missing');
    }
    try {
      const preparation = held.prepareEmbeddedPostgres({
        signal: new AbortController().signal,
        timeoutMs: 60_000,
      });
      await process.started;
      const coalesced = held.prepareEmbeddedPostgres({
        signal: new AbortController().signal,
        timeoutMs: 60_000,
      });
      journal.blockNext();
      const pendingProgress = held.progress.progress('postgres-initialization');
      await journal.entered;
      const firstClosePending = held.close().then(
        () => 'resolved',
        () => 'rejected',
      );
      const secondClose = await Promise.race([
        held.close().then(
          () => 'resolved',
          () => 'rejected',
        ),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
      ]);
      const busy = await this.open(fixture);
      await process.exit();
      await process.exited;
      const beforeDrain = await this.open(fixture);
      const beforeDrainClose = await held.close().then(
        () => 'resolved',
        () => 'rejected',
      );
      journal.release();
      await pendingProgress;
      const firstClose = await firstClosePending;
      const outcome = await preparation.then(
        () => 'resolved',
        () => 'rejected',
      );
      const replacement = await this.acquireEventually(fixture);
      if (replacement.kind !== 'held') {
        throw new Error('replacement owner missing');
      }
      await held.close();
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
      await replacement.close();
      return {
        firstClose,
        secondClose,
        outcome,
        coalesced: coalesced === preparation,
        busy: busy.kind,
        beforeDrain: beforeDrain.kind,
        beforeDrainClose,
        replacement: replacement.kind,
        retained,
        secretByPathOnly: process.request?.args.some((value) => value.includes('--pwfile=')),
        environment: process.request?.env,
      };
    } finally {
      journal.release();
      await process.exit().catch(() => undefined);
      await held.close().catch(() => undefined);
    }
  }

  async cleanup() {
    await Promise.all(
      this.roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  }

  private async fixture() {
    const root = await mkdtemp('/tmp/pg-');
    this.roots.push(root);
    const dataDir = join(root, 'data');
    const runtimeDir = join(root, 'run');
    await Promise.all([mkdir(dataDir, { mode: 0o700 }), mkdir(runtimeDir, { mode: 0o700 })]);
    await Promise.all([chmod(dataDir, 0o700), chmod(runtimeDir, 0o700)]);
    return { dataDir, runtimeDir };
  }

  private open(
    fixture: { dataDir: string; runtimeDir: string },
    postgres?: EmbeddedPostgresPreparationService,
    journal?: StartupProgressJournalWriter,
  ) {
    const resource = postgres ? new EmbeddedPostgresResourceService(postgres) : undefined;
    return new PublishedControlService(
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
    });
  }

  private acquireEventually(
    fixture: { dataDir: string; runtimeDir: string },
    deadline = Date.now() + 1000,
  ): ReturnType<PostgresScenario['open']> {
    return this.open(fixture).then((candidate) => {
      if (candidate.kind === 'held' || Date.now() >= deadline) {
        return candidate;
      }
      return new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
        this.acquireEventually(fixture, deadline),
      );
    });
  }
}

class FailingCancellationProcess extends ManagedProcessService {
  request: ManagedProcessRequest | undefined;
  private owned: OwnedProcess | undefined;
  private notifyStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.notifyStarted = resolve;
  });
  exited!: Promise<ProcessCompletion>;

  override async start(request: ManagedProcessRequest): Promise<OwnedProcess> {
    this.request = request;
    const { cancellation: _cancellation, ...processRequest } = request;
    this.owned = await super.start({
      ...processRequest,
      executable: process.execPath,
      args: ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    });
    this.exited = this.owned.completion;
    const cancellationResult = new Promise<ProcessCancellationResult>((resolve) => {
      request.cancellation?.signal.addEventListener(
        'abort',
        () =>
          resolve({
            kind: 'failed',
            error: new ManagedProcessError(
              'revo.process.stop-timeout',
              'Managed process did not exit.',
            ),
          }),
        { once: true },
      );
    });
    this.notifyStarted();
    return { completion: this.exited, cancellationResult };
  }

  async exit() {
    if (!this.owned) {
      throw new Error('process not started');
    }
    await this.stop(this.owned, { graceMs: 0, killWaitMs: 5000 });
  }
}
