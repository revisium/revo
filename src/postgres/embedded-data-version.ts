import { constants, type FileHandle, lstat, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { compareSemVer, isSemVerString } from '../release-metadata.js';
import { RevoConsoleLogger } from '../server-logs/revo-console-logger.js';
import { syncDirectory } from './directory-sync.js';
import type { EmbeddedPostgresBackupService } from './embedded-postgres-backup.service.js';
import { EmbeddedPostgresError, type PreparedEmbeddedPostgres } from './embedded-postgres.types.js';

const DATA_VERSION_FILE = 'data-version.json';
const STAGED_DATA_VERSION_FILE = '.data-version.json.tmp';
const DATA_VERSION_SCHEMA = 1;
const MAX_DATA_VERSION_BYTES = 4096;
const MIB = 1024 * 1024;
const restoreRemedy =
  '. To return to this older Revo, restore database-backup in the data directory as the Revo README describes';
const logger = new RevoConsoleLogger('EmbeddedPostgres');

/** Data this Revo may open: its own, an earlier version's, or data without a recorded version. */
export type AdmittedData =
  | { readonly kind: 'current' }
  | { readonly kind: 'earlier'; readonly version: string }
  | { readonly kind: 'unrecorded' };

/**
 * Guards one embedded data directory against Revo versions it was not prepared for. The data
 * directory ownership lock is held by the caller, so no other Revo reads or writes the record.
 */
export class EmbeddedDataVersion {
  private readonly path: string;

  constructor(
    private readonly dataDir: string,
    private readonly runningVersion: string,
    private readonly backups: EmbeddedPostgresBackupService,
  ) {
    this.path = join(dataDir, DATA_VERSION_FILE);
  }

  /** Refuses data that a newer Revo opened, or whose version is unknown; it changes nothing. */
  async admit(): Promise<AdmittedData> {
    const recorded = await this.read();
    if (recorded === undefined) {
      return { kind: 'unrecorded' };
    }
    const order = compareSemVer(recorded, this.runningVersion);
    if (order > 0) {
      throw new EmbeddedPostgresError('incompatible', false, undefined, {
        detail:
          `the data in ${this.dataDir} was last opened by Revo ${recorded}, which is newer than ` +
          `this Revo ${this.runningVersion}; nothing was changed. Use Revo ${recorded} or newer ` +
          `with this data${(await this.hasBackup()) ? restoreRemedy : ''}`,
      });
    }
    if (order === 0) {
      return { kind: 'current' };
    }
    return { kind: 'earlier', version: recorded };
  }

  private hasBackup(): Promise<boolean> {
    return lstat(join(this.dataDir, 'database-backup')).then(
      () => true,
      () => false,
    );
  }

  /**
   * Saves the latest backup of data that another Revo version prepared, then records this version.
   * Both happen while PostgreSQL is stopped, before Revo Core can change the database structure.
   */
  async adopt(
    admitted: AdmittedData,
    cluster: PreparedEmbeddedPostgres,
    signal: AbortSignal,
  ): Promise<void> {
    if (admitted.kind === 'current') {
      return;
    }
    if (!cluster.created) {
      await this.backUp(admitted, cluster, signal);
    }
    await this.record();
  }

  private async backUp(
    admitted: Exclude<AdmittedData, { readonly kind: 'current' }>,
    cluster: PreparedEmbeddedPostgres,
    signal: AbortSignal,
  ) {
    const backup = await this.backups.replace({
      dataDir: this.dataDir,
      clusterDir: cluster.clusterDir,
      dataVersionFile: this.path,
      signal,
    });
    const origin =
      admitted.kind === 'earlier' ? `Revo ${admitted.version}` : 'an earlier Revo version';
    logger.log(
      `Saved the database backup ${backup.path} (${String(Math.ceil(backup.bytes / MIB))} MiB in ` +
        `${String(backup.elapsedMs)} ms) before Revo ${this.runningVersion} opens data from ${origin}.`,
    );
  }

  /** Returns the recorded version, or undefined when the data has no record yet. */
  private async read(): Promise<string | undefined> {
    let content: string;
    try {
      content = await readSmallFile(this.path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return undefined;
      }
      throw this.unreadable();
    }
    const version = parseDataVersion(content);
    if (version === undefined) {
      throw this.unreadable();
    }
    return version;
  }

  private async record(): Promise<void> {
    const staged = join(this.dataDir, STAGED_DATA_VERSION_FILE);
    const content = serializeDataVersion(this.runningVersion);
    try {
      await rm(staged, { force: true });
      const file = await open(staged, 'wx', 0o600);
      try {
        await file.writeFile(content, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(staged, this.path);
      await syncDirectory(this.dataDir);
    } catch (error) {
      throw new EmbeddedPostgresError('invalid', false, undefined, {
        detail: `the data version file ${this.path} could not be written (${errorSummary(error)})`,
      });
    }
  }

  private unreadable(): EmbeddedPostgresError {
    return new EmbeddedPostgresError('invalid', false, undefined, {
      detail:
        `the data version file ${this.path} is unreadable or has an unknown format, so the Revo ` +
        'version that last opened this data is unknown; nothing was changed. If Revo ' +
        `${this.runningVersion} or an older version last used this data, remove the file and ` +
        'start again',
    });
  }
}

async function readSmallFile(path: string): Promise<string> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_DATA_VERSION_BYTES) {
      throw new Error('not a small regular file');
    }
    return await file.readFile('utf8');
  } finally {
    await file?.close();
  }
}

const serializeDataVersion = (version: string) =>
  `${JSON.stringify({ schemaVersion: DATA_VERSION_SCHEMA, version })}\n`;

function parseDataVersion(content: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const schemaVersion: unknown = Reflect.get(value, 'schemaVersion');
  const version: unknown = Reflect.get(value, 'version');
  if (
    schemaVersion !== DATA_VERSION_SCHEMA ||
    typeof version !== 'string' ||
    !isSemVerString(version)
  ) {
    return undefined;
  }
  return version;
}

const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;

const errorSummary = (error: unknown) => (error instanceof Error ? error.message : String(error));
