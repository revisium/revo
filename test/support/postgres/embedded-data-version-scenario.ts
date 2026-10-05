import { execFile, fork } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Client } from 'pg';

import { EmbeddedPostgresBackupService } from '../../../src/postgres/embedded-postgres-backup.service.js';
import { EmbeddedPostgresPreparationService } from '../../../src/postgres/embedded-postgres-preparation.service.js';
import { EmbeddedPostgresResourceService } from '../../../src/postgres/embedded-postgres-resource.service.js';
import { EmbeddedPostgresError } from '../../../src/postgres/embedded-postgres.types.js';
import type { PublishedControl } from '../../../src/processes/control-discovery.types.js';
import type { ManagedProcessRequest } from '../../../src/processes/managed-process.types.js';
import { PublishedControlService } from '../../../src/processes/published-control.service.js';
import { ClusterFixture } from './postgres-readiness-scenario.js';
import { TrackedPostgresProcesses } from './tracked-postgres-processes.js';

const DATA_VERSION_FILE = 'data-version.json';
const BACKUP_LINK = 'database-backup';
const BACKUP_STORE = '.database-backups';
const README_RESTORE = 'rm -rf postgres data-version.json && cp -Rp database-backup/. .';
const SUPERVISOR = new URL('./embedded-postgres-supervisor.mjs', import.meta.url);
const OPERATION = 'dadadadadadadadadadadadadadadada';
const START_TIMEOUT_MS = 60_000;

export type DataVersionStart =
  | { readonly kind: 'started' }
  | { readonly kind: 'rejected'; readonly reason: string; readonly message: string };

export interface StoredBackup {
  readonly target: string;
  readonly version: string | undefined;
  readonly files: Readonly<Record<string, string>>;
}

export interface DataWhenPostgresStarted {
  readonly recordedVersion: string | undefined;
  readonly backupVersion: string | undefined;
}

export class EmbeddedDataVersionScenario {
  private readonly owners: PublishedControl[] = [];
  private readonly clusters: ClusterFixture[] = [];
  private root = '';
  private dataDir = '';
  private logDir = '';
  private runtimeDir = '';
  private owner: PublishedControl | undefined;
  private port: number | undefined;
  private observedAtPostgresStart: DataWhenPostgresStarted | undefined;

  async setup(): Promise<this> {
    this.root = await realpath(await mkdtemp('/tmp/pdv-'));
    this.dataDir = join(this.root, 'd');
    this.logDir = join(this.root, 'l');
    this.runtimeDir = join(this.root, 'r');
    await Promise.all([
      mkdir(this.dataDir, { mode: 0o700 }),
      mkdir(this.runtimeDir, { mode: 0o700 }),
    ]);
    return this;
  }

  get postgresStarted(): boolean {
    return this.observedAtPostgresStart !== undefined;
  }

  dataWhenPostgresStarted(): DataWhenPostgresStarted | undefined {
    return this.observedAtPostgresStart;
  }

  async dataPreparedBy(version: string, value: string): Promise<void> {
    const outcome = await this.startAs(version);
    if (outcome.kind !== 'started') {
      throw new Error(`Revo ${version} did not start: ${outcome.message}`);
    }
    await this.commit(value);
    await this.stop();
  }

  async dataVersionFileContains(content: string): Promise<void> {
    await writeFile(this.dataVersionPath(), content, { mode: 0o600 });
  }

  async dataVersionFileReplacedByADirectory(): Promise<void> {
    await rm(this.dataVersionPath());
    await mkdir(this.dataVersionPath(), { mode: 0o700 });
  }

  async dataVersionFileRemoved(): Promise<void> {
    await rm(this.dataVersionPath());
  }

  async backupPathOccupiedByAUserDirectory(): Promise<void> {
    await mkdir(join(this.dataDir, BACKUP_LINK), { mode: 0o700 });
  }

  async backupStoreReplacedByALinkToAForeignDirectory(): Promise<string> {
    const foreign = join(this.root, 'foreign');
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(join(foreign, 'keep-me'), 'x');
    await symlink(foreign, join(this.dataDir, BACKUP_STORE));
    return foreign;
  }

  async directoryModes(directory: 'source' | 'backup'): Promise<Record<string, number>> {
    const root =
      directory === 'source'
        ? join(this.dataDir, 'postgres')
        : join(this.dataDir, BACKUP_LINK, 'postgres');
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const paths = [
      root,
      ...entries
        .filter((item) => item.isDirectory())
        .map((item) => join(item.parentPath, item.name)),
    ];
    const stats = await Promise.all(paths.map((path) => lstat(path)));
    return Object.fromEntries(
      paths.map((path, index) => [
        path.slice(root.length + 1) || '.',
        Number(stats[index]?.mode) & 0o7777,
      ]),
    );
  }

  startAs(version: string): Promise<DataVersionStart> {
    return this.start(version, new EmbeddedPostgresBackupService());
  }

  startWithoutRoomForABackupAs(version: string): Promise<DataVersionStart> {
    return this.start(version, new FullDiskBackupService());
  }

  async backupInterruptedByAPowerCutAs(version: string): Promise<void> {
    const supervisor = fork(SUPERVISOR, ['inside-backup'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        REVO_TEST_DATA: this.dataDir,
        REVO_TEST_LOG: this.logDir,
        REVO_TEST_RUNTIME: this.runtimeDir,
        REVO_TEST_VERSION: version,
      },
    });
    const exit = await new Promise<NodeJS.Signals | null>((resolve) =>
      supervisor.once('exit', (_code, signal) => resolve(signal)),
    );
    if (exit !== 'SIGKILL') {
      throw new Error(`the interrupted backup ended with ${String(exit)} instead of a power cut`);
    }
  }

  async startExternalAs(version: string): Promise<DataVersionStart> {
    const cluster = await ClusterFixture.start('trust');
    this.clusters.push(cluster);
    const owner = await new PublishedControlService().open({
      ...this.locations(),
      version,
      channel: 'stable',
      databaseUrl: cluster.connectionUrl(),
      onStop: () => undefined,
      startupProgress: { operationId: OPERATION, now: () => Date.now() },
    });
    this.owners.push(owner);
    return this.startDatabase(owner);
  }

  async commit(value: string): Promise<void> {
    await this.query(async (client) => {
      await client.query('CREATE TABLE IF NOT EXISTS sentinel (value text NOT NULL)');
      await client.query('INSERT INTO sentinel (value) VALUES ($1)', [value]);
    });
  }

  committedValues(): Promise<string[]> {
    return this.query(async (client) => {
      const result = await client.query<{ value: string }>(
        'SELECT value FROM sentinel ORDER BY value',
      );
      return result.rows.map(({ value }) => value);
    });
  }

  async stop(): Promise<void> {
    const owner = this.owner;
    this.owner = undefined;
    this.port = undefined;
    if (owner?.kind === 'held') {
      await owner.close();
    }
  }

  async restoreBackupAsReadmeDescribes(): Promise<void> {
    await promisify(execFile)('sh', ['-c', README_RESTORE], { cwd: this.dataDir });
  }

  async recordedVersion(): Promise<string | undefined> {
    return readVersionFile(this.dataVersionPath());
  }

  async backup(): Promise<StoredBackup | undefined> {
    let target: string;
    try {
      target = await readlink(join(this.dataDir, BACKUP_LINK));
    } catch {
      return undefined;
    }
    const directory = join(this.dataDir, target);
    return {
      target,
      version: await readVersionFile(join(directory, DATA_VERSION_FILE)),
      files: await fileSnapshot(directory),
    };
  }

  async storedBackups(): Promise<string[]> {
    return readdir(join(this.dataDir, BACKUP_STORE)).catch(() => []);
  }

  async databaseSnapshot(): Promise<Readonly<Record<string, string>>> {
    return {
      ...(await fileSnapshot(join(this.dataDir, 'postgres'))),
      [DATA_VERSION_FILE]: await readFile(this.dataVersionPath(), 'utf8').catch(() => 'missing'),
      'postgres-password': await readFile(join(this.dataDir, 'postgres-password'), 'utf8'),
    };
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled(
      this.owners.map((owner) => (owner.kind === 'held' ? owner.close() : Promise.resolve())),
    );
    await Promise.allSettled(this.clusters.map((cluster) => cluster.close()));
    await rm(this.root, { recursive: true, force: true });
  }

  private async start(
    version: string,
    backups: EmbeddedPostgresBackupService,
  ): Promise<DataVersionStart> {
    this.observedAtPostgresStart = undefined;
    const processes = new DataObservingProcesses(async () => {
      this.observedAtPostgresStart = {
        recordedVersion: await this.recordedVersion(),
        backupVersion: (await this.backup())?.version,
      };
    });
    const owner = await new PublishedControlService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new EmbeddedPostgresResourceService(
        new EmbeddedPostgresPreparationService(processes),
        processes,
        undefined,
        undefined,
        backups,
      ),
    ).open({
      ...this.locations(),
      version,
      channel: 'stable',
      onStop: () => undefined,
      startupProgress: { operationId: OPERATION, now: () => Date.now() },
    });
    this.owners.push(owner);
    return this.startDatabase(owner);
  }

  private async startDatabase(owner: PublishedControl): Promise<DataVersionStart> {
    if (owner.kind !== 'held' || !owner.startDatabase) {
      throw new Error('data directory is unexpectedly owned');
    }
    try {
      const started = await owner.startDatabase({
        signal: new AbortController().signal,
        timeoutMs: START_TIMEOUT_MS,
      });
      this.owner = owner;
      this.port = started.kind === 'embedded' ? started.port : undefined;
      return { kind: 'started' };
    } catch (error) {
      await owner.close();
      if (!(error instanceof EmbeddedPostgresError)) {
        throw error;
      }
      return { kind: 'rejected', reason: error.reason, message: error.message };
    }
  }

  private async query<T>(session: (client: Client) => Promise<T>): Promise<T> {
    if (this.port === undefined) {
      throw new Error('the embedded database is not running');
    }
    const client = new Client({
      host: '127.0.0.1',
      port: this.port,
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

  private locations() {
    return { dataDir: this.dataDir, logDir: this.logDir, runtimeDir: this.runtimeDir };
  }

  private dataVersionPath(): string {
    return join(this.dataDir, DATA_VERSION_FILE);
  }
}

class DataObservingProcesses extends TrackedPostgresProcesses {
  constructor(private readonly observePostgresStart: () => Promise<void>) {
    super();
  }

  override async start(request: ManagedProcessRequest) {
    if (request.args[0] === '-D') {
      await this.observePostgresStart();
    }
    return super.start(request);
  }
}

class FullDiskBackupService extends EmbeddedPostgresBackupService {
  protected override freeBytes(): Promise<number> {
    return Promise.resolve(0);
  }
}

async function readVersionFile(path: string): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof value === 'object' && value !== null && 'version' in value
      ? String(value.version)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Names, sizes and modification times: any write to the copied tree changes the snapshot. */
async function fileSnapshot(directory: string): Promise<Readonly<Record<string, string>>> {
  const entries = (await readdir(directory, { recursive: true })).toSorted();
  const described = await Promise.all(
    entries.map(async (entry) => {
      const metadata = await lstat(join(directory, entry));
      const size = metadata.isDirectory() ? 'directory' : String(metadata.size);
      return [entry, `${size}:${String(metadata.mtimeMs)}`] as const;
    }),
  );
  return Object.fromEntries(described);
}
