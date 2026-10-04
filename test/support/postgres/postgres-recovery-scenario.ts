import { fork, spawn, type ChildProcess } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { uptime } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';

import { EmbeddedPostgresError } from '../../../src/postgres/embedded-postgres.types.js';
import type { PublishedControl } from '../../../src/processes/control-discovery.types.js';
import { ProcessIdentityService } from '../../../src/processes/process-identity.service.js';
import { PublishedControlService } from '../../../src/processes/published-control.service.js';
import { ClusterFixture } from './postgres-readiness-scenario.js';

export type InitializationInterruption = 'before-initdb' | 'inside-initdb' | 'after-initdb';

export interface Supervisor {
  readonly port: number;
  readonly postmasterPid: number;
  kill(): Promise<void>;
}

export interface Bystander {
  readonly pid: number;
  receivedSignals(): Promise<readonly string[]>;
}

export type StartOutcome =
  | { readonly kind: 'started'; readonly port: number }
  | { readonly kind: 'rejected'; readonly reason: string; readonly message: string };

const HOUR_SECONDS = 3600;
const SUPERVISOR = new URL('./embedded-postgres-supervisor.mjs', import.meta.url);
const BYSTANDER = `
for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGUSR1', 'SIGUSR2']) {
  process.on(signal, () => received.push(signal));
}
const received = [];
process.on('message', () => process.send({ received }));
process.send({ ready: true });
`;

export class PostgresRecoveryScenario {
  private readonly owners: PublishedControl[] = [];
  private readonly children = new Set<ChildProcess>();
  private readonly postmasters = new Set<number>();
  private readonly foreignServers: ClusterFixture[] = [];
  private root = '';
  private dataDir = '';
  private logDir = '';
  private runtimeDir = '';
  private port: number | undefined;

  async setup(): Promise<this> {
    this.root = await realpath(await mkdtemp('/tmp/prc-'));
    this.dataDir = join(this.root, 'd');
    this.logDir = join(this.root, 'l');
    this.runtimeDir = join(this.root, 'r');
    await Promise.all([
      mkdir(this.dataDir, { mode: 0o700 }),
      mkdir(this.runtimeDir, { mode: 0o700 }),
    ]);
    return this;
  }

  async preparedCluster(): Promise<void> {
    const owner = await this.open();
    await owner.prepareEmbeddedPostgres?.({
      signal: new AbortController().signal,
      timeoutMs: 60_000,
    });
    await owner.close();
  }

  async runningSupervisor(): Promise<Supervisor> {
    const child = this.supervisor('serve');
    const { port } = await new Promise<{ port: number }>((resolve, reject) => {
      child.once('message', (message: { port: number }) => resolve(message));
      child.once('exit', () => reject(new Error('supervisor exited before the database started')));
    });
    const postmasterPid = Number((await this.lockFile())?.split('\n')[0]);
    this.postmasters.add(postmasterPid);
    return {
      port,
      postmasterPid,
      kill: async () => {
        child.kill('SIGKILL');
        await exited(child);
      },
    };
  }

  async interruptFirstInitialization(point: InitializationInterruption): Promise<void> {
    await exited(this.supervisor(point));
  }

  async legacyEmptyClusterDirectory(credential?: string): Promise<void> {
    await mkdir(join(this.dataDir, 'postgres'), { mode: 0o700 });
    if (credential !== undefined) {
      await writeFile(join(this.dataDir, 'postgres-password'), credential, { mode: 0o600 });
    }
  }

  async bystander(): Promise<Bystander> {
    const child = spawn(process.execPath, ['-e', BYSTANDER], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.children.add(child);
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
    });
    return {
      pid: requiredPid(child),
      receivedSignals: () =>
        new Promise((resolve) => {
          child.once('message', (message: { received: string[] }) => resolve(message.received));
          child.send('report');
        }),
    };
  }

  async exitedProcess(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await exited(child);
    return requiredPid(child);
  }

  async foreignServer(): Promise<ClusterFixture> {
    const server = await ClusterFixture.start('trust');
    this.foreignServers.push(server);
    return server;
  }

  async lockFileNaming(pid: number, recordedStart: 'an hour earlier' | 'an hour later') {
    const now = Math.floor(Date.now() / 1000);
    const startedAt = recordedStart === 'an hour earlier' ? now - HOUR_SECONDS : now + HOUR_SECONDS;
    const lines = [pid, this.clusterDir(), startedAt, 5432, '', '127.0.0.1', '  0  0', 'ready   '];
    await writeFile(this.lockPath(), `${lines.join('\n')}\n`, { mode: 0o600 });
  }

  async lockFileWrittenBeforeBoot(): Promise<void> {
    const beforeBoot = Date.now() / 1000 - uptime() - 60;
    await utimes(this.lockPath(), beforeBoot, beforeBoot);
  }

  async incompleteLockFile(): Promise<void> {
    await writeFile(this.lockPath(), '', { mode: 0o600 });
  }

  async lockFileCopiedFrom(server: ClusterFixture): Promise<void> {
    await copyFile(join(server.root, 'd', 'postmaster.pid'), this.lockPath());
  }

  lockFile(): Promise<string | undefined> {
    return readFile(this.lockPath(), 'utf8').catch(() => undefined);
  }

  async start(): Promise<StartOutcome> {
    const owner = await this.open();
    try {
      const started = await owner.startDatabase?.({
        signal: new AbortController().signal,
        timeoutMs: 60_000,
      });
      if (started?.kind !== 'embedded') {
        throw new Error('embedded database missing');
      }
      this.port = started.port;
      return { kind: 'started', port: started.port };
    } catch (error) {
      if (!(error instanceof EmbeddedPostgresError)) {
        throw error;
      }
      return { kind: 'rejected', reason: error.reason, message: error.message };
    }
  }

  async commit(value: string, port = this.port): Promise<void> {
    await this.query(port, async (client) => {
      await client.query('CREATE TABLE IF NOT EXISTS sentinel (value text NOT NULL)');
      await client.query('INSERT INTO sentinel (value) VALUES ($1)', [value]);
    });
  }

  committedValues(): Promise<string[]> {
    return this.query(this.port, async (client) => {
      const result = await client.query<{ value: string }>(
        'SELECT value FROM sentinel ORDER BY value',
      );
      return result.rows.map(({ value }) => value);
    });
  }

  async isRunning(pid: number): Promise<boolean> {
    return new ProcessIdentityService().capture(pid).then(
      () => true,
      () => false,
    );
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled(
      this.owners.map((owner) => (owner.kind === 'held' ? owner.close() : Promise.resolve())),
    );
    await Promise.allSettled(
      [...this.postmasters].map(async (pid) => {
        if (await this.isRunning(pid)) {
          process.kill(pid, 'SIGQUIT');
        }
      }),
    );
    for (const child of this.children) {
      child.kill('SIGKILL');
    }
    await Promise.allSettled([...this.children].map((child) => exited(child)));
    await Promise.allSettled(this.foreignServers.map((server) => server.close()));
    await rm(this.root, { recursive: true, force: true });
  }

  private supervisor(mode: 'serve' | InitializationInterruption): ChildProcess {
    const child = fork(SUPERVISOR, [mode], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        REVO_TEST_DATA: this.dataDir,
        REVO_TEST_LOG: this.logDir,
        REVO_TEST_RUNTIME: this.runtimeDir,
      },
    });
    this.children.add(child);
    return child;
  }

  private async open() {
    const owner = await new PublishedControlService().open({
      dataDir: this.dataDir,
      logDir: this.logDir,
      runtimeDir: this.runtimeDir,
      version: '1.2.3',
      channel: 'stable',
      onStop: () => undefined,
      startupProgress: { operationId: 'abcdef0123456789abcdef0123456789', now: () => Date.now() },
    });
    this.owners.push(owner);
    if (owner.kind !== 'held') {
      throw new Error('data directory is unexpectedly owned');
    }
    return owner;
  }

  private async query<T>(port: number | undefined, session: (client: Client) => Promise<T>) {
    if (port === undefined) {
      throw new Error('database was not started');
    }
    const client = new Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password: await readFile(join(this.dataDir, 'postgres-password'), 'utf8'),
      database: 'revo',
      ssl: false,
    });
    await client.connect();
    try {
      return await session(client);
    } finally {
      await client.end();
    }
  }

  private clusterDir() {
    return join(this.dataDir, 'postgres');
  }

  private lockPath() {
    return join(this.clusterDir(), 'postmaster.pid');
  }
}

const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once('exit', () => resolve()));

const requiredPid = (child: ChildProcess) => {
  if (child.pid === undefined) {
    throw new Error('fixture process did not spawn');
  }
  return child.pid;
};
