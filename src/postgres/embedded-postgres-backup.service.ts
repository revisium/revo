import { randomBytes } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  statfs,
  symlink,
} from 'node:fs/promises';
import { basename, join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { syncDirectory } from './directory-sync.js';
import { EmbeddedPostgresError } from './embedded-postgres.types.js';

const BACKUP_LINK = 'database-backup';
const BACKUP_STORE = '.database-backups';
const STAGED_LINK_PREFIX = '.database-backup-';
const BACKUP_ID = /^\.database-backups\/([0-9a-f]{16})$/u;
const BATCH = 32;
const BLOCK_BYTES = 512;
const MIB = 1024 * 1024;

export interface DatabaseBackupRequest {
  readonly dataDir: string;
  readonly clusterDir: string;
  readonly dataVersionFile: string;
  readonly signal: AbortSignal;
}

export interface SavedDatabaseBackup {
  readonly path: string;
  readonly bytes: number;
  readonly elapsedMs: number;
}

interface BackupLayout {
  readonly dataDir: string;
  readonly link: string;
  readonly store: string;
}

type BackupLink =
  | { readonly kind: 'missing' }
  | { readonly kind: 'revo'; readonly id: string }
  | { readonly kind: 'foreign' };

/**
 * Keeps the latest copy of a stopped embedded cluster. `database-backup` is a symbolic link to a
 * complete copy; a new copy is staged beside it and published by renaming a new link over the old
 * one, so an interrupted backup never replaces or damages the previous complete copy.
 */
@Injectable()
export class EmbeddedPostgresBackupService {
  async replace(request: DatabaseBackupRequest): Promise<SavedDatabaseBackup> {
    const started = Date.now();
    const layout = backupLayout(request.dataDir);
    try {
      const bytes = await this.prepareRoom(layout, request.clusterDir);
      const id = await this.stage(layout, request);
      await publish(layout, id);
      await discardBackupsExcept(layout, id);
      return { path: layout.link, bytes, elapsedMs: Date.now() - started };
    } catch (error) {
      throw backupFailure(error, layout);
    }
  }

  private async prepareRoom(layout: BackupLayout, clusterDir: string): Promise<number> {
    await mkdir(layout.store, { recursive: true, mode: 0o700 });
    const link = await readBackupLink(layout);
    if (link.kind === 'foreign') {
      throw new EmbeddedPostgresError('backup', false, undefined, {
        detail:
          `${layout.link} is not a backup that Revo saved, so Revo does not replace it; the ` +
          'database was not changed. Move it out of the data directory and start again',
      });
    }
    await discardBackupsExcept(layout, link.kind === 'revo' ? link.id : undefined);
    const bytes = await allocatedBytes(clusterDir);
    const free = await this.freeBytes(layout.dataDir);
    if (free < bytes) {
      throw new EmbeddedPostgresError('backup', false, undefined, {
        detail:
          `the database backup needs ${String(Math.ceil(bytes / MIB))} MiB of free disk space ` +
          `in ${layout.dataDir}, but only ${String(Math.floor(free / MIB))} MiB is available; the ` +
          'database was not changed. Free disk space and start again',
      });
    }
    return bytes;
  }

  private async stage(layout: BackupLayout, request: DatabaseBackupRequest): Promise<string> {
    const id = randomBytes(8).toString('hex');
    const staged = join(layout.store, id);
    try {
      await mkdir(staged, { mode: 0o700 });
      await this.copyCluster(request.clusterDir, join(staged, 'postgres'), request.signal);
      await copyDataVersion(request.dataVersionFile, staged);
      await syncTree(staged);
      return id;
    } catch (error) {
      await rm(staged, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  protected copyCluster(clusterDir: string, destination: string, signal: AbortSignal) {
    return cp(clusterDir, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
      filter: () => {
        if (signal.aborted) {
          throw new EmbeddedPostgresError('cancelled');
        }
        return true;
      },
    });
  }

  protected async freeBytes(path: string): Promise<number> {
    const stats = await statfs(path);
    return stats.bavail * stats.bsize;
  }
}

const backupLayout = (dataDir: string): BackupLayout => ({
  dataDir,
  link: join(dataDir, BACKUP_LINK),
  store: join(dataDir, BACKUP_STORE),
});

async function readBackupLink(layout: BackupLayout): Promise<BackupLink> {
  let target: string;
  try {
    target = await readlink(layout.link);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'foreign' };
  }
  const id = BACKUP_ID.exec(target)?.[1];
  return id === undefined ? { kind: 'foreign' } : { kind: 'revo', id };
}

/** Removes copies that no link references: replaced backups and interrupted attempts. */
async function discardBackupsExcept(layout: BackupLayout, kept: string | undefined) {
  const [copies, entries] = await Promise.all([
    readdir(layout.store).catch(() => []),
    readdir(layout.dataDir).catch(() => []),
  ]);
  const stagedLinks = entries.filter(
    (name) => name.startsWith(STAGED_LINK_PREFIX) && name.endsWith('.tmp'),
  );
  await Promise.allSettled([
    ...copies
      .filter((name) => name !== kept)
      .map((name) => rm(join(layout.store, name), { recursive: true, force: true })),
    ...stagedLinks.map((name) => rm(join(layout.dataDir, name), { force: true })),
  ]);
}

async function allocatedBytes(clusterDir: string): Promise<number> {
  const entries = await readdir(clusterDir, { recursive: true, withFileTypes: true });
  const sizes = await inBatches(
    entries.filter((entry) => entry.isFile()),
    async (entry) => (await lstat(entryPath(entry))).blocks * BLOCK_BYTES,
  );
  return sizes.reduce((total, size) => total + size, 0);
}

async function copyDataVersion(dataVersionFile: string, staged: string) {
  try {
    await copyFile(
      dataVersionFile,
      join(staged, basename(dataVersionFile)),
      constants.COPYFILE_EXCL,
    );
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
}

async function syncTree(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const paths = entries
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry) => entryPath(entry));
  await inBatches(paths, syncPath);
  await syncDirectory(root);
}

async function syncPath(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publish(layout: BackupLayout, id: string) {
  const staged = join(layout.dataDir, `${STAGED_LINK_PREFIX}${id}.tmp`);
  try {
    await symlink(join(BACKUP_STORE, id), staged);
    await rename(staged, layout.link);
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(layout.dataDir);
}

function backupFailure(error: unknown, layout: BackupLayout): EmbeddedPostgresError {
  if (error instanceof EmbeddedPostgresError) {
    return error;
  }
  const code = errorCode(error);
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new EmbeddedPostgresError('backup', false, undefined, {
      detail:
        `there was not enough free disk space in ${layout.dataDir} for the database backup; the ` +
        'database was not changed. Free disk space and start again',
    });
  }
  return new EmbeddedPostgresError('backup', false, undefined, {
    detail: `the database backup ${layout.link} could not be saved (${errorSummary(error)}); the database was not changed`,
  });
}

/** Bounds open descriptors: a cluster has thousands of files and macOS allows 256 by default. */
async function inBatches<T, R>(
  items: readonly T[],
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const batch = await Promise.all(items.slice(0, BATCH).map(operation));
  return [...batch, ...(await inBatches(items.slice(BATCH), operation))];
}

const entryPath = (entry: Dirent) => join(entry.parentPath, entry.name);

const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;

const errorSummary = (error: unknown) => (error instanceof Error ? error.message : String(error));
