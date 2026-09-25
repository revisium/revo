import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from 'pg';

import { loadEmbeddedPostgresBinaries } from '../../../src/postgres/embedded-postgres-binaries.js';
import { EmbeddedPostgresReadiness } from '../../../src/postgres/embedded-postgres-readiness.js';
import { LoopbackPortAllocator } from '../../../src/postgres/loopback-port-allocator.js';
import { ManagedProcessService } from '../../../src/processes/managed-process.service.js';
import type { OwnedProcess } from '../../../src/processes/managed-process.types.js';
import { ProcessExitWaiter } from '../../../src/processes/process-exit-waiter.js';
import { cleanupRegistered, observeFixtureCleanup } from './fixture-cleanup.js';

const PASSWORD = 'fixture-password';
const NONCE = 'revo-readiness-fixture';
const INITDB_TIMEOUT_MS = 60_000;
const PROCESS_STOP = { graceMs: 1_000, killWaitMs: 5_000 } as const;

export const REAL_PG_SCENARIO_TIMEOUT_MS = 90_000;

export class PostgresReadinessScenario {
  private readonly clusters: ClusterFixture[] = [];
  private closing = false;

  async initializesTheOwnedDatabase() {
    const cluster = await this.cluster('scram');
    await withHostilePostgresEnvironment(() => cluster.initialize(NONCE));
    return {
      databaseExists: await cluster.databaseExists(),
      query: await cluster.queryRevo('SELECT 41 + 1 AS value'),
      serverAlive: await cluster.isAlive(),
    };
  }

  async rejectsAnotherTrustAuthenticatedCluster() {
    const cluster = await this.cluster('trust');
    const outcome = await cluster.initialize('another-startup').then(
      () => 'resolved',
      (error: unknown) => safeFailure(error),
    );
    return {
      outcome,
      databaseExists: await cluster.databaseExists(),
      serverAlive: await cluster.isAlive(),
    };
  }

  async rejectsBadAuthenticationSafely() {
    const cluster = await this.cluster('scram');
    const outcome = await cluster.initialize(NONCE, 'wrong-password').then(
      () => 'resolved',
      (error: unknown) => safeFailure(error),
    );
    return {
      outcome,
      databaseExists: await cluster.databaseExists(),
      serverAlive: await cluster.isAlive(),
    };
  }

  async closeCancelsOnlyItsBlockedSql() {
    const cluster = await this.cluster('scram');
    const blocker = await cluster.client('postgres');
    try {
      await blockDatabaseInspection(blocker);
      const readiness = new EmbeddedPostgresReadiness();
      const pending = observed(cluster.initialize(NONCE, PASSWORD, readiness));
      const session = await waitForBlockedReadiness(blocker, Date.now() + 2000);
      const closes = Promise.allSettled([readiness.close(), readiness.close()]);
      await blocker.query('SELECT pg_cancel_backend($1)', [session]);
      const settledCloses = await closes;
      const outcome = await pending;
      await blocker.query('ROLLBACK');
      return {
        outcome,
        closes: settledCloses.map(({ status }) => status),
        sessionGone: await waitForSessionGone(blocker, session, Date.now() + 1000),
        databaseExists: await cluster.databaseExists(),
        serverAlive: await cluster.isAlive(),
      };
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    }
  }

  async safelyHandlesTerminatedSqlConnection() {
    const cluster = await this.cluster('scram');
    const blocker = await cluster.client('postgres');
    const readiness = new EmbeddedPostgresReadiness();
    try {
      await blockDatabaseInspection(blocker);
      const pending = observed(cluster.initialize(NONCE, PASSWORD, readiness));
      const session = await waitForBlockedReadiness(blocker, Date.now() + 2000);
      await blocker.query('SELECT pg_terminate_backend($1)', [session]);
      const outcome = await pending;
      const close = await readiness.close().then(
        () => 'resolved',
        (error: unknown) => safeFailure(error),
      );
      return {
        outcome,
        close,
        sessionGone: await waitForSessionGone(blocker, session, Date.now() + 1000),
        serverAlive: await cluster.isAlive(),
      };
    } finally {
      await readiness.close().catch(() => undefined);
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    }
  }

  async observesServerStatementTimeout() {
    const cluster = await this.cluster('scram');
    const blocker = await cluster.client('postgres');
    const readiness = new EmbeddedPostgresReadiness();
    try {
      await blockDatabaseInspection(blocker);
      const pending = observed(cluster.initialize(NONCE, PASSWORD, readiness));
      const session = await waitForBlockedReadiness(blocker, Date.now() + 2000);
      const outcome = await pending;
      const close = await observed(readiness.close());
      await blocker.query('ROLLBACK');
      return {
        outcome,
        close,
        observedTimeout: await cluster.waitForStatementTimeout(Date.now() + 1000),
        sessionGone: await waitForSessionGone(blocker, session, Date.now() + 1000),
        databaseExists: await cluster.databaseExists(),
        serverAlive: await cluster.isAlive(),
      };
    } finally {
      await readiness.close().catch(() => undefined);
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    }
  }

  async rejectsUnconfirmedSqlDrainAtTheOriginalDeadline() {
    const cluster = await this.cluster('scram');
    const blocker = await cluster.client('postgres');
    const readiness = new EmbeddedPostgresReadiness();
    let session: number | undefined;
    try {
      await blockDatabaseInspection(blocker);
      const pending = observed(cluster.initialize(NONCE, PASSWORD, readiness));
      session = await waitForBlockedReadiness(blocker, Date.now() + 2000);
      process.kill(session, 'SIGSTOP');
      const closes = await Promise.all([observed(readiness.close()), observed(readiness.close())]);
      process.kill(session, 'SIGCONT');
      await blocker.query('SELECT pg_terminate_backend($1)', [session]);
      await blocker.query('ROLLBACK');
      return {
        closes,
        outcome: await pending,
        databaseExists: await cluster.databaseExists(),
        serverAlive: await cluster.isAlive(),
      };
    } finally {
      if (session !== undefined) {
        try {
          process.kill(session, 'SIGCONT');
        } catch {
          // The owned backend already exited.
        }
      }
      await readiness.close().catch(() => undefined);
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    }
  }

  async reservesAnActualLoopbackPort() {
    const reservation = await new LoopbackPortAllocator().reserve();
    const whileHeld = await canListen(reservation.port);
    await reservation.release();
    const afterRelease = await canListen(reservation.port);
    return { whileHeld, afterRelease };
  }

  async cleanup() {
    this.closing = true;
    await cleanupRegistered(this.clusters, (cluster) => cluster.close());
  }

  private async cluster(authentication: 'scram' | 'trust') {
    if (this.closing) {
      throw new Error('readiness scenario is closing');
    }
    const cluster = ClusterFixture.create(authentication);
    this.clusters.push(cluster);
    await cluster.start();
    if (this.closing) {
      throw new Error('readiness scenario is closing');
    }
    return cluster;
  }
}

export class ClusterFixture {
  private rootPath: string | undefined;
  private fixturePort: number | undefined;
  private readonly processes = new ManagedProcessService();
  private readonly children = new Set<OwnedProcess>();
  private readonly completed = new Set<OwnedProcess>();
  private readonly stops = new Map<OwnedProcess, Promise<void>>();
  private reservation: Awaited<ReturnType<LoopbackPortAllocator['reserve']>> | undefined;
  private statementTimeout: () => boolean = () => false;
  private starting: Promise<void> | undefined;
  private closing = false;
  private closeOperation: Promise<void> | undefined;

  private constructor(
    private readonly authentication: 'scram' | 'trust',
    private readonly requestedPort?: number,
  ) {}

  static create(authentication: 'scram' | 'trust', requestedPort?: number) {
    return new ClusterFixture(authentication, requestedPort);
  }

  get root() {
    if (this.rootPath === undefined) {
      throw new Error('fixture root is not available');
    }
    return this.rootPath;
  }

  get port() {
    if (this.fixturePort === undefined) {
      throw new Error('fixture port is not available');
    }
    return this.fixturePort;
  }

  start(): Promise<void> {
    if (this.closing) {
      return Promise.reject(new Error('fixture is closing'));
    }
    this.starting ??= this.performStart();
    return this.starting;
  }

  private requireOpen() {
    if (this.closing) {
      throw new Error('fixture is closing');
    }
  }

  private track(child: OwnedProcess) {
    this.children.add(child);
    void child.completion.then(
      () => this.completed.add(child),
      () => undefined,
    );
    this.requireOpen();
  }

  private async performStart() {
    try {
      this.rootPath = await mkdtemp('/tmp/pr-');
      this.requireOpen();
      const root = this.root;
      const data = join(root, 'd');
      const passwordFile = join(root, 'p');
      const binaries = await loadEmbeddedPostgresBinaries();
      this.requireOpen();
      await writeFile(passwordFile, PASSWORD, { mode: 0o600 });
      this.requireOpen();
      await initializeCluster(
        this.processes,
        binaries.initdb,
        data,
        passwordFile,
        root,
        this.authentication,
        (child) => this.track(child),
      );
      this.requireOpen();
      if (this.requestedPort === undefined) {
        this.reservation = await new LoopbackPortAllocator().reserve();
        this.requireOpen();
      }
      this.fixturePort = this.requestedPort ?? this.reservation?.port;
      await this.releaseReservation();
      this.requireOpen();
      const started = await startPostgres(
        this.processes,
        binaries.postgres,
        data,
        root,
        this.port,
        (child) => this.track(child),
      );
      this.statementTimeout = started.statementTimeout;
      this.requireOpen();
      await this.waitUntilAlive(Date.now() + 5000);
      this.requireOpen();
    } catch (primary) {
      this.closing = true;
      // Do not call close(): it waits for this startup operation to settle.
      const cleanup = await this.releaseResources().then(
        () => undefined,
        (error: unknown) => ({ error }),
      );
      if (cleanup) {
        throw startupCleanupFailure(primary, cleanup.error);
      }
      throw primary;
    }
  }

  initialize(
    startupNonce: string,
    password = PASSWORD,
    readiness = new EmbeddedPostgresReadiness(),
  ) {
    return readiness.initialize({
      port: this.port,
      password,
      startupNonce,
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });
  }

  async client(database: string) {
    const client = new Client({
      host: '127.0.0.1',
      port: this.port,
      user: 'postgres',
      password: PASSWORD,
      database,
      ssl: false,
      connectionTimeoutMillis: 1000,
    });
    await client.connect();
    return client;
  }

  async databaseExists() {
    const client = await this.client('postgres');
    try {
      const result = await client.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
        ['revo'],
      );
      return result.rows[0]?.exists;
    } finally {
      await client.end();
    }
  }

  connectionUrl(database = 'postgres', sslMode: 'disable' | 'verify-full' = 'disable') {
    return `postgresql://postgres:${PASSWORD}@127.0.0.1:${this.port}/${database}?sslmode=${sslMode}`;
  }

  async createDatabase(database: string) {
    const client = await this.client('postgres');
    try {
      await client.query(`CREATE DATABASE ${database}`);
    } finally {
      await client.end();
    }
  }

  async activeRevoDatabases() {
    const client = await this.client('postgres');
    try {
      const result = await client.query<{ datname: string }>(
        `SELECT datname FROM pg_stat_activity
         WHERE application_name = 'revo' AND pid <> pg_backend_pid()`,
      );
      return result.rows.map(({ datname }) => datname);
    } finally {
      await client.end();
    }
  }

  async terminateRevoSessions() {
    const client = await this.client('postgres');
    try {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE application_name = 'revo' AND pid <> pg_backend_pid()`,
      );
    } finally {
      await client.end();
    }
  }

  async queryRevo(statement: string) {
    const client = await this.client('revo');
    try {
      return (await client.query<{ value: number }>(statement)).rows[0]?.value;
    } finally {
      await client.end();
    }
  }

  isAlive() {
    return this.client('postgres').then(async (client) => {
      try {
        return (await client.query('SELECT 1')).rowCount === 1;
      } finally {
        await client.end();
      }
    });
  }

  observedStatementTimeout() {
    return this.statementTimeout();
  }

  async waitForStatementTimeout(deadline: number): Promise<boolean> {
    if (this.observedStatementTimeout()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return this.waitForStatementTimeout(deadline);
  }

  close(): Promise<void> {
    this.closing = true;
    this.closeOperation ??= this.performClose();
    return this.closeOperation;
  }

  private stopChild(child: OwnedProcess): Promise<void> {
    const previous = this.stops.get(child);
    if (previous) {
      return previous;
    }
    const stopping = observeFixtureCleanup(
      (async () => {
        if (!this.completed.has(child)) {
          await this.processes.stop(child, PROCESS_STOP);
        }
        // A rejected stop never falls through into an unbounded completion wait.
        await child.completion;
      })(),
    );
    this.stops.set(child, stopping);
    return stopping;
  }

  private async stopChildren() {
    const results = await Promise.allSettled(
      [...this.children].map((child) => this.stopChild(child)),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Fixture process cleanup unconfirmed');
    }
  }

  private async releaseReservation() {
    if (this.reservation) {
      await this.reservation.release();
      this.reservation = undefined;
    }
  }

  private async releaseResources() {
    const results = await Promise.allSettled([
      this.stopChildren(),
      observeFixtureCleanup(this.releaseReservation()),
    ]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Fixture resources retained');
    }
    if (this.rootPath !== undefined) {
      await rm(this.rootPath, { recursive: true, force: true });
    }
  }

  private async performClose() {
    // Interrupt currently owned initdb/postgres without waiting for startup first.
    // Startup checks closing after every acquisition, including a late spawn.
    const results = await Promise.allSettled([
      this.stopChildren(),
      observeFixtureCleanup(
        this.starting?.then(
          () => undefined,
          () => undefined,
        ) ?? Promise.resolve(),
      ),
    ]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Fixture close unconfirmed');
    }
    await this.releaseResources();
  }

  private async waitUntilAlive(deadline: number): Promise<void> {
    this.requireOpen();
    if (await this.isAlive().catch(() => false)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error('fixture postgres failed readiness');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return this.waitUntilAlive(deadline);
  }
}

const startupCleanupFailure = (primary: unknown, cleanup: unknown) =>
  new AggregateError([primary, cleanup], 'Fixture startup and cleanup failed', { cause: primary });

const initializeCluster = async (
  processes: ManagedProcessService,
  executable: string,
  data: string,
  passwordFile: string,
  root: string,
  authentication: 'scram' | 'trust',
  track: (child: OwnedProcess) => void,
) => {
  const initdb = await processes.start({
    executable,
    args: [
      `--pgdata=${data}`,
      '--encoding=UTF8',
      '--locale=C',
      `--auth=${authentication === 'trust' ? 'trust' : 'scram-sha-256'}`,
      '--username=postgres',
      `--pwfile=${passwordFile}`,
      '--no-instructions',
    ],
    cwd: root,
    env: { LC_ALL: 'C' },
    stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
  });
  track(initdb);
  initdb.stderr?.resume();
  const completed = await new ProcessExitWaiter().wait(initdb.completion, INITDB_TIMEOUT_MS);
  if (!completed) {
    throw new Error('fixture initdb timed out');
  }
  const completion = await initdb.completion;
  if (completion.exitCode !== 0 || completion.signal !== null) {
    throw new Error('fixture initdb failed');
  }
};

const startPostgres = async (
  processes: ManagedProcessService,
  executable: string,
  data: string,
  root: string,
  port: number,
  track: (child: OwnedProcess) => void,
) => {
  const process = await processes.start({
    executable,
    args: [
      '-D',
      data,
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-c',
      `unix_socket_directories=${root}`,
      '-c',
      `cluster_name=${NONCE}`,
      '-c',
      'log_min_messages=ERROR',
      '-c',
      'log_min_error_statement=ERROR',
    ],
    cwd: root,
    env: { LC_ALL: 'C' },
    stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
  });
  track(process);
  const marker = 'canceling statement due to statement timeout';
  let tail = '';
  let observed = false;
  process.stderr?.on('data', (chunk) => {
    const combined = tail + String(chunk);
    observed ||= combined.includes(marker);
    tail = combined.slice(-(marker.length - 1));
  });
  process.stderr?.resume();
  return { process, statementTimeout: () => observed };
};

const blockDatabaseInspection = async (client: Client) => {
  await client.query('BEGIN');
  await client.query('LOCK TABLE pg_database IN SHARE MODE');
};

const waitForBlockedReadiness = async (client: Client, deadline: number): Promise<number> => {
  await client.query('SELECT pg_stat_clear_snapshot()');
  const result = await client.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity
     WHERE application_name = $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
    ['revo'],
  );
  const pid = result.rows[0]?.pid;
  if (pid !== undefined) {
    return pid;
  }
  if (Date.now() >= deadline) {
    throw new Error('readiness SQL did not reach the owned lock wait');
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  return waitForBlockedReadiness(client, deadline);
};

const sessionExists = async (client: Client, pid: number) => {
  await client.query('SELECT pg_stat_clear_snapshot()');
  const result = await client.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1) AS exists',
    [pid],
  );
  return result.rows[0]?.exists;
};

const waitForSessionGone = async (
  client: Client,
  pid: number,
  deadline: number,
): Promise<boolean> => {
  if (!(await sessionExists(client, pid))) {
    return true;
  }
  if (Date.now() >= deadline) {
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  return waitForSessionGone(client, pid, deadline);
};

const observed = (operation: Promise<void>) =>
  operation.then(
    () => 'resolved' as const,
    (error: unknown) => safeFailure(error),
  );

const safeFailure = (error: unknown) =>
  error instanceof Error
    ? { name: error.name, message: error.message, hasCause: 'cause' in error }
    : { name: typeof error, message: String(error), hasCause: false };

const canListen = async (port: number) => {
  const { createServer } = await import('node:net');
  const server = createServer();
  return new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });
};

const withHostilePostgresEnvironment = async <T>(action: () => Promise<T>) => {
  const names = [
    'PGCLIENT_ENCODING',
    'PGSSLNEGOTIATION',
    'PGOPTIONS',
    'PGREPLICATION',
    'PGAPPNAME',
    'PGSSLMODE',
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    PGCLIENT_ENCODING: 'SQL_ASCII',
    PGSSLNEGOTIATION: 'direct',
    PGOPTIONS: '-c invalid=true',
    PGREPLICATION: 'database',
    PGAPPNAME: 'hostile',
    PGSSLMODE: 'require',
  });
  try {
    return await action();
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};
