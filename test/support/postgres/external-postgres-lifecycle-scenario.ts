import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { EmbeddedPostgresResourceService } from '../../../src/postgres/embedded-postgres-resource.service.js';
import { buildExternalPostgresClientConfig } from '../../../src/postgres/external-postgres-client-config.js';
import {
  ExternalPostgresResourceService,
  OwnedExternalPostgresResource,
} from '../../../src/postgres/external-postgres-resource.service.js';
import type { PublishedControl } from '../../../src/processes/control-discovery.types.js';
import { ManagedProcessService } from '../../../src/processes/managed-process.service.js';
import type { OwnedProcess } from '../../../src/processes/managed-process.types.js';
import { ProcessExitWaiter } from '../../../src/processes/process-exit-waiter.js';
import { PublishedControlService } from '../../../src/processes/published-control.service.js';
import { StartupProgressJournalWriter } from '../../../src/startup-progress/startup-progress-journal.service.js';
import { BlockingJournal } from '../startup-progress/blocking-journal.js';
import { ClusterFixture } from './postgres-readiness-scenario.js';

const OPERATION = 'abcdefabcdefabcdefabcdefabcdefab';
const CHILD_TIMEOUT_MS = 5_000;
const CHILD_STOP = { graceMs: 1_000, killWaitMs: 5_000 } as const;
const MAX_CHILD_OUTPUT_BYTES = 16 * 1024;

export const REAL_PG_CLEANUP_TIMEOUT_MS = 16_000;

export class ExternalPostgresLifecycleScenario {
  private readonly roots: string[] = [];
  private readonly owners: PublishedControl[] = [];
  private readonly clusters: ClusterFixture[] = [];
  private readonly servers: Server[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly children = new Map<OwnedProcess, ManagedProcessService>();

  async connectsToTheSelectedDatabaseWithoutOwningTheServer() {
    const cluster = await this.cluster();
    await cluster.createDatabase('external_target');
    const owner = await this.open(
      cluster.connectionUrl('external_target'),
      new ForbiddenEmbedded(),
    );
    if (owner.kind !== 'held' || owner.databaseKind !== 'external' || !owner.startDatabase) {
      throw new Error('external database owner missing');
    }
    const request = { signal: new AbortController().signal, timeoutMs: 5000 };
    const first = owner.startDatabase(request);
    const coalesced = owner.startDatabase(request);
    const results = await Promise.all([first, coalesced]);
    const activeDatabases = await cluster.activeRevoDatabases();
    await owner.close();
    return {
      results,
      samePromise: first === coalesced,
      activeDatabases,
      embeddedPreparationExposed: 'prepareEmbeddedPostgres' in owner,
      revoDatabaseCreated: await cluster.databaseExists(),
      serverAlive: await cluster.isAlive(),
    };
  }

  async rejectsPlainPostgresByDefaultButAllowsExplicitDisable() {
    const cluster = await this.cluster();
    const rejected = await this.startOutcome(
      await this.open(cluster.connectionUrl('postgres', 'verify-full')),
    );
    const acceptedOwner = await this.open(cluster.connectionUrl());
    const accepted = await this.startOutcome(acceptedOwner);
    await acceptedOwner.close();
    return { rejected, accepted, serverAlive: await cluster.isAlive() };
  }

  async rejectsAnExplicitEmptyUrlWithoutSelectingEmbedded() {
    return this.open('', new ForbiddenEmbedded()).then(
      () => 'resolved' as const,
      (error: unknown) =>
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: typeof error, message: String(error) },
    );
  }

  async cancellationAndConnectionFailureAreSafeAndBounded() {
    const cluster = await this.cluster();
    const cancelledOwner = await this.open(cluster.connectionUrl());
    const controller = new AbortController();
    controller.abort();
    const cancelledAt = Date.now();
    const cancelled = await this.startOutcome(cancelledOwner, controller.signal);
    await cancelledOwner.close();
    const failedOwner = await this.open(
      'postgresql://postgres:secret@127.0.0.1:1/postgres?sslmode=disable',
    );
    const failedAt = Date.now();
    const failed = await this.startOutcome(failedOwner, new AbortController().signal, 300);
    await failedOwner.close().catch(() => undefined);
    return {
      cancelled,
      cancelledMs: Date.now() - cancelledAt,
      failed,
      failedMs: Date.now() - failedAt,
      serverAlive: await cluster.isAlive(),
    };
  }

  async rejectsTimeoutAbortAndTransportFailureAcrossAcceptedJournalWrites() {
    const cluster = await this.cluster();
    const timeoutJournal = new BlockingJournal();
    const timeoutOwner = await this.open(cluster.connectionUrl(), undefined, timeoutJournal);
    timeoutJournal.blockNext();
    const timed = this.startOutcome(timeoutOwner, new AbortController().signal, 50);
    await timeoutJournal.entered;
    await new Promise((resolve) => setTimeout(resolve, 75));
    timeoutJournal.release();
    const timeout = await timed;
    await timeoutOwner.close().catch(() => undefined);

    const deadlineJournal = new BlockingJournal();
    const deadlineOwner = await this.open(cluster.connectionUrl(), undefined, deadlineJournal);
    deadlineJournal.blockExternalCompletion();
    const deadlineStart = this.startOutcome(deadlineOwner, new AbortController().signal, 50);
    await deadlineJournal.entered;
    await new Promise((resolve) => setTimeout(resolve, 75));
    deadlineJournal.release();
    const deadlineAfterSql = await deadlineStart;
    await deadlineOwner.close().catch(() => undefined);

    const closeJournal = new BlockingJournal();
    const closeOwner = await this.open(cluster.connectionUrl(), undefined, closeJournal);
    closeJournal.blockExternalCompletion();
    const closingStart = this.startOutcome(closeOwner);
    await closeJournal.entered;
    const closing = closeOwner.close();
    closeJournal.release();
    const abort = await closingStart;
    await closing;

    const transportFixture = await this.fixture();
    const transportJournal = new BlockingJournal();
    const transportOwner = await this.openAt(
      transportFixture,
      cluster.connectionUrl(),
      undefined,
      transportJournal,
    );
    transportJournal.blockExternalCompletion();
    const transportStart = this.startOutcome(transportOwner);
    await transportJournal.entered;
    await cluster.terminateRevoSessions();
    transportJournal.release();
    const transport = await transportStart;
    const transportClose = await this.closeOutcome(transportOwner);
    const transportReopened = await this.acquireEventually(transportFixture, Date.now() + 2000);
    if (transportReopened.kind === 'held') {
      await transportReopened.close();
    }
    return {
      timeout,
      deadlineAfterSql,
      abort,
      transport,
      transportClose,
      transportReopened: transportReopened.kind,
      serverAlive: await cluster.isAlive(),
    };
  }

  async retainsOwnershipUntilDelayedPublicClientEndSettles() {
    return {
      endThenJournal: await this.delayedDrainOrder('end-first'),
      journalThenEnd: await this.delayedDrainOrder('journal-first'),
    };
  }

  private async delayedDrainOrder(order: 'end-first' | 'journal-first') {
    const fixture = await this.fixture();
    const client = new DelayedEndClient();
    const external = new FakeExternalPostgresResourceService(client.client);
    const journal = new BlockingJournal();
    journal.blockExternalCompletion();
    const gatedOwner = await this.openAt(
      fixture,
      'postgres://db.example?sslmode=disable',
      undefined,
      journal,
      external,
    );
    const starting = this.startOutcome(gatedOwner);
    await journal.entered;
    const closing = gatedOwner.close().then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );
    try {
      const closeOutcome = await closing;
      const busy = await this.openResult(fixture);
      if (order === 'end-first') {
        client.releaseEnd();
      } else {
        journal.release();
      }
      if (order === 'journal-first') {
        await starting;
      }
      const afterFirstDrain =
        order === 'journal-first'
          ? await this.acquireEventually(fixture, Date.now() + 100)
          : await this.openResult(fixture);
      if (afterFirstDrain.kind === 'held') {
        await afterFirstDrain.close();
      }
      client.releaseEnd();
      journal.release();
      if (order === 'end-first') {
        await starting;
      }
      const reopened = await this.acquireEventually(fixture, Date.now() + 2000);
      if (reopened.kind === 'held') {
        await reopened.close();
      }
      return {
        closeOutcome,
        busy: busy.kind,
        afterFirstDrain: afterFirstDrain.kind,
        reopened: reopened.kind,
        queries: client.queries,
      };
    } finally {
      client.releaseEnd();
      journal.release();
    }
  }

  async abortsARealStalledConnectionWithoutStoppingTheForeignListener() {
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => (accept = resolve));
    const server = createServer((socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      accept();
    });
    this.servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('listener address missing');
    }
    const owner = await this.open(`postgres://127.0.0.1:${address.port}/postgres?sslmode=disable`);
    const controller = new AbortController();
    const starting = this.startOutcome(owner, controller.signal, 5000);
    await accepted;
    const startedAt = Date.now();
    controller.abort();
    const outcome = await starting;
    await owner.close().catch(() => undefined);
    return { outcome, elapsedMs: Date.now() - startedAt, listenerAlive: server.listening };
  }

  async isolatesHostilePostgresEnvironmentInARealChild() {
    const cluster = await this.cluster();
    const root = await mkdtemp('/tmp/external-pg-env-');
    this.roots.push(root);
    const passfile = join(root, 'pgpass');
    await writeFile(passfile, `127.0.0.1:${cluster.port}:postgres:postgres:fixture-password\n`, {
      mode: 0o600,
    });
    const child = fileURLToPath(new URL('./external-postgres-env-child.mjs', import.meta.url));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PGPORT: '0',
      PGPASSFILE: passfile,
      PGOPTIONS: '-c invalid=true',
      PGSSLMODE: 'verify-full',
      PGAPPNAME: 'hostile',
    };
    delete env.PGPASSWORD;
    const explicit = await this.executeChild(child, [cluster.connectionUrl()], env);
    const missingPassword = await this.executeChild(
      child,
      [`postgres://postgres@127.0.0.1:${cluster.port}/postgres?sslmode=disable`],
      env,
    );
    return {
      explicit: JSON.parse(explicit),
      missingPassword: JSON.parse(missingPassword),
    };
  }

  async cleanup() {
    await Promise.allSettled(
      this.owners.map((owner) => (owner.kind === 'held' ? owner.close() : Promise.resolve())),
    );
    const childCleanup = await Promise.allSettled(
      [...this.children].map(async ([child, processes]) => {
        await processes.stop(child, CHILD_STOP);
        await child.completion;
        this.children.delete(child);
      }),
    );
    await Promise.allSettled(this.clusters.map((cluster) => cluster.close()));
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await Promise.all(
      this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    if (childCleanup.some((result) => result.status === 'rejected')) {
      throw new Error('External PostgreSQL child cleanup could not be confirmed');
    }
    await Promise.all(
      this.roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  }

  private async executeChild(entry: string, args: readonly string[], env: NodeJS.ProcessEnv) {
    const processes = new ManagedProcessService();
    const child = await processes.start({
      executable: process.execPath,
      args: [entry, ...args],
      cwd: process.cwd(),
      env: definedEnvironment(env),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    });
    this.children.set(child, processes);
    child.stderr?.resume();
    const stdout = readOutput(child);
    void stdout.catch(() => undefined);
    if (!(await new ProcessExitWaiter().wait(child.completion, CHILD_TIMEOUT_MS))) {
      await processes.stop(child, CHILD_STOP);
    }
    const completion = await child.completion;
    this.children.delete(child);
    if (completion.exitCode !== 0 || completion.signal !== null) {
      throw new Error('External PostgreSQL fixture child failed');
    }
    return stdout;
  }

  private async cluster() {
    const cluster = await ClusterFixture.start('scram');
    this.clusters.push(cluster);
    return cluster;
  }

  private async fixture() {
    const root = await mkdtemp('/tmp/external-pg-');
    this.roots.push(root);
    const fixture = {
      dataDir: join(root, 'data'),
      logDir: join(root, 'logs'),
      runtimeDir: join(root, 'runtime'),
    };
    await Promise.all([
      mkdir(fixture.dataDir, { mode: 0o700 }),
      mkdir(fixture.runtimeDir, { mode: 0o700 }),
    ]);
    return fixture;
  }

  private async open(
    databaseUrl: string,
    embedded = new EmbeddedPostgresResourceService(),
    journal?: StartupProgressJournalWriter,
  ) {
    return this.openAt(await this.fixture(), databaseUrl, embedded, journal);
  }

  private async openAt(
    fixture: { dataDir: string; logDir: string; runtimeDir: string },
    databaseUrl: string,
    embedded = new EmbeddedPostgresResourceService(),
    journal?: StartupProgressJournalWriter,
    external?: ExternalPostgresResourceService,
  ) {
    const owner = await new PublishedControlService(
      undefined,
      undefined,
      undefined,
      undefined,
      journal,
      embedded,
      external,
    ).open({
      ...fixture,
      databaseUrl,
      version: '1.0.0',
      channel: 'stable',
      onStop: () => undefined,
      startupProgress: { operationId: OPERATION, now: () => performance.now() },
    });
    this.owners.push(owner);
    if (owner.kind !== 'held' || owner.databaseKind !== 'external') {
      throw new Error('external database owner missing');
    }
    return owner;
  }

  private openResult(fixture: { dataDir: string; logDir: string; runtimeDir: string }) {
    return new PublishedControlService().open({
      ...fixture,
      databaseUrl: 'postgres://db.example?sslmode=disable',
      version: '1.0.0',
      channel: 'stable',
      onStop: () => undefined,
      startupProgress: { operationId: OPERATION, now: () => performance.now() },
    });
  }

  private async acquireEventually(
    fixture: { dataDir: string; logDir: string; runtimeDir: string },
    deadline: number,
  ): Promise<PublishedControl> {
    const owner = await this.openResult(fixture);
    if (owner.kind === 'held' || Date.now() >= deadline) {
      return owner;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    return this.acquireEventually(fixture, deadline);
  }

  private async startOutcome(
    owner: PublishedControl,
    signal = new AbortController().signal,
    timeoutMs = 5000,
  ) {
    if (owner.kind !== 'held' || owner.databaseKind !== 'external' || !owner.startDatabase) {
      throw new Error('external database owner missing');
    }
    return owner.startDatabase({ signal, timeoutMs }).then(
      (result) => result,
      (error: unknown) =>
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              code: 'code' in error ? String(error.code) : undefined,
            }
          : { name: typeof error, message: String(error) },
    );
  }

  private closeOutcome(owner: Extract<PublishedControl, { kind: 'held' }>) {
    return owner.close().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) =>
        error instanceof Error
          ? {
              kind: 'rejected' as const,
              name: error.name,
              message: error.message,
              code: 'code' in error ? String(error.code) : undefined,
            }
          : { kind: 'rejected' as const, name: typeof error, message: String(error) },
    );
  }
}

const definedEnvironment = (environment: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

async function readOutput(child: OwnedProcess): Promise<string> {
  if (!child.stdout) {
    throw new Error('External PostgreSQL fixture child stdout is unavailable');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of child.stdout) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += buffer.length;
    if (length > MAX_CHILD_OUTPUT_BYTES) {
      throw new Error('External PostgreSQL fixture child output is too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

class DelayedEndClient {
  readonly client = new Client();
  readonly queries: string[] = [];
  private release!: () => void;
  private readonly ended = new Promise<void>((resolve) => (this.release = resolve));
  constructor() {
    Object.defineProperties(this.client, {
      connect: { value: () => Promise.resolve() },
      query: {
        value: (statement: string) => {
          this.queries.push(statement);
          return Promise.resolve({ rows: [{ '?column?': 1 }] });
        },
      },
      end: { value: () => this.ended },
    });
  }
  releaseEnd() {
    this.release();
  }
}

class ForbiddenEmbedded extends EmbeddedPostgresResourceService {
  override bind(): never {
    throw new Error('embedded boundary called');
  }
}

class FakeExternalPostgresResourceService extends ExternalPostgresResourceService {
  constructor(private readonly client: Client) {
    super();
  }

  override bind(
    connectionUrl: string,
    progress: import('../../../src/startup-progress/index.js').StartupProgressFacade,
  ) {
    return new OwnedExternalPostgresResource(
      buildExternalPostgresClientConfig(connectionUrl),
      progress,
      () => this.client,
    );
  }
}
