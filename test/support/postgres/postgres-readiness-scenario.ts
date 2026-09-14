import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from 'pg';

import { loadEmbeddedPostgresBinaries } from '../../../src/postgres/embedded-postgres-binaries.js';
import { EmbeddedPostgresReadiness } from '../../../src/postgres/embedded-postgres-readiness.js';
import { LoopbackPortAllocator } from '../../../src/postgres/loopback-port-allocator.js';
import { ManagedProcessService } from '../../../src/processes/managed-process.service.js';
import type { OwnedProcess } from '../../../src/processes/managed-process.types.js';

const PASSWORD = 'fixture-password';
const NONCE = 'revo-readiness-fixture';

export class PostgresReadinessScenario {
  private readonly clusters: ClusterFixture[] = [];

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
    await Promise.allSettled(this.clusters.map((cluster) => cluster.close()));
    this.clusters.length = 0;
  }

  private async cluster(authentication: 'scram' | 'trust') {
    const cluster = await ClusterFixture.start(authentication);
    this.clusters.push(cluster);
    return cluster;
  }
}

export class ClusterFixture {
  private constructor(
    readonly root: string,
    readonly port: number,
    private readonly process: OwnedProcess,
    private readonly processes: ManagedProcessService,
    private readonly statementTimeout: () => boolean,
  ) {}

  static async start(authentication: 'scram' | 'trust', requestedPort?: number) {
    const root = await mkdtemp('/tmp/pr-');
    const processes = new ManagedProcessService();
    let process: OwnedProcess | undefined;
    try {
      const data = join(root, 'd');
      const passwordFile = join(root, 'p');
      const binaries = await loadEmbeddedPostgresBinaries();
      await writeFile(passwordFile, PASSWORD, { mode: 0o600 });
      await initializeCluster(processes, binaries.initdb, data, passwordFile, root, authentication);
      const reservation =
        requestedPort === undefined ? await new LoopbackPortAllocator().reserve() : undefined;
      let port: number;
      if (requestedPort !== undefined) {
        port = requestedPort;
      } else if (reservation !== undefined) {
        port = reservation.port;
      } else {
        throw new Error('loopback port reservation missing');
      }
      await reservation?.release();
      const started = await startPostgres(processes, binaries.postgres, data, root, port);
      process = started.process;
      const fixture = new ClusterFixture(root, port, process, processes, started.statementTimeout);
      await fixture.waitUntilAlive(Date.now() + 5000);
      return fixture;
    } catch (primary) {
      if (process) {
        await processes.stop(process, { graceMs: 1000, killWaitMs: 5000 }).catch(() => undefined);
        await process.completion;
      }
      await rm(root, { recursive: true, force: true });
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

  async close() {
    await this.processes.stop(this.process, { graceMs: 1000, killWaitMs: 5000 });
    await this.process.completion;
    await rm(this.root, { recursive: true, force: true });
  }

  private async waitUntilAlive(deadline: number): Promise<void> {
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

const initializeCluster = async (
  processes: ManagedProcessService,
  executable: string,
  data: string,
  passwordFile: string,
  root: string,
  authentication: 'scram' | 'trust',
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
  initdb.stderr?.resume();
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
