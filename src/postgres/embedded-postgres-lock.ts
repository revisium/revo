import { constants } from 'node:fs';
import { type FileHandle, open, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { ManagedProcessService } from '../processes/managed-process.service.js';
import { ProcessIdentityService } from '../processes/process-identity.service.js';
import type { IdentityObservation } from '../processes/process-identity.types.js';
import type { EmbeddedPostgresLog } from './embedded-postgres-log.js';
import { EmbeddedPostgresError } from './embedded-postgres.types.js';

const LOCK_FILE = 'postmaster.pid';
const MAX_LOCK_FILE_BYTES = 4096;
const START_TOLERANCE_SECONDS = 2;
const MAX_STOP_SECONDS = 60;
const STOP_CANCEL_GRACE_MS = 1000;
const STOP_CANCEL_KILL_WAIT_MS = 5000;

export interface ReleaseClusterLockRequest {
  readonly clusterDir: string;
  readonly pgCtl: string;
  readonly log: EmbeddedPostgresLog;
  readonly signal: AbortSignal;
  readonly deadline: number;
}

type ClusterLock =
  | { readonly kind: 'absent' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'running'; readonly pid: number }
  | { readonly kind: 'uncertain'; readonly reason: string };

type LockRecovery =
  | { readonly kind: 'released' }
  | { readonly kind: 'refused'; readonly detail: string };

type WorkingLocation = 'cluster' | 'elsewhere' | 'gone' | 'unknown';

/** Callers hold the data-directory ownership lock, so no other Revo server races this recovery. */
@Injectable()
export class EmbeddedPostgresLockRecovery {
  constructor(
    @Inject(ProcessIdentityService)
    private readonly identity: ProcessIdentityService = new ProcessIdentityService(),
    @Inject(ManagedProcessService)
    private readonly processes: ManagedProcessService = new ManagedProcessService(),
  ) {}

  async releaseAbandonedLock(request: ReleaseClusterLockRequest): Promise<void> {
    const recovery = await this.recover(request);
    if (recovery.kind === 'refused') {
      await request.log.record(recovery.detail);
      throw new EmbeddedPostgresError('locked', false, undefined, { detail: recovery.detail });
    }
  }

  private async recover(request: ReleaseClusterLockRequest): Promise<LockRecovery> {
    let lock = await this.inspect(request.clusterDir);
    if (lock.kind === 'running') {
      await this.stopOrphanedServer(request);
      lock = await this.inspect(request.clusterDir);
    }
    if (lock.kind === 'stale') {
      return discardStaleLock(request.clusterDir);
    }
    if (lock.kind === 'absent') {
      return { kind: 'released' };
    }
    return refused(refusalDetail(request.clusterDir, lock));
  }

  private async inspect(clusterDir: string): Promise<ClusterLock> {
    const file = await readLockFile(join(clusterDir, LOCK_FILE));
    if (file.kind === 'missing') {
      return { kind: 'absent' };
    }
    if (file.kind === 'unsafe') {
      return { kind: 'uncertain', reason: 'it is not a private regular file' };
    }
    const server = parseRecordedServer(file.content);
    if (server?.dataDir === clusterDir) {
      return this.identify(server, clusterDir);
    }
    if (file.modifiedAt < this.identity.bootedAt() - START_TOLERANCE_SECONDS) {
      return { kind: 'stale' };
    }
    if (!server) {
      return { kind: 'uncertain', reason: 'it is incomplete' };
    }
    return { kind: 'uncertain', reason: `it names another data directory, ${server.dataDir}` };
  }

  private async identify(server: RecordedServer, clusterDir: string): Promise<ClusterLock> {
    const pid = String(server.pid);
    const observation = await this.identity.observe(server.pid);
    if (observation.kind === 'missing' || ownedByAnotherUser(observation)) {
      return { kind: 'stale' };
    }
    if (observation.kind !== 'captured') {
      return { kind: 'uncertain', reason: `process ${pid} cannot be inspected` };
    }
    const location = await this.workingLocation(server.pid, clusterDir);
    if (location === 'gone' || location === 'elsewhere') {
      return { kind: 'stale' };
    }
    if (location === 'unknown') {
      return {
        kind: 'uncertain',
        reason: `the working directory of process ${pid} cannot be inspected`,
      };
    }
    const startedAt = this.identity.startedAt(observation.identity);
    if (Math.abs(startedAt - server.startedAt) <= START_TOLERANCE_SECONDS) {
      return { kind: 'running', pid: server.pid };
    }
    return {
      kind: 'uncertain',
      reason: `process ${pid} works in the cluster directory but did not start when the lock file records`,
    };
  }

  private async workingLocation(pid: number, clusterDir: string): Promise<WorkingLocation> {
    const [observed, cluster] = await Promise.all([
      this.identity.workingDirectory(pid),
      stat(clusterDir, { bigint: true }),
    ]);
    if (observed.kind === 'missing') {
      return 'gone';
    }
    if (observed.kind === 'unknown') {
      return 'unknown';
    }
    const { device, inode } = observed.directory;
    return device === cluster.dev && inode === cluster.ino ? 'cluster' : 'elsewhere';
  }

  private async stopOrphanedServer(request: ReleaseClusterLockRequest): Promise<void> {
    const seconds = Math.min(
      MAX_STOP_SECONDS,
      Math.max(1, Math.floor((request.deadline - Date.now()) / 1000)),
    );
    const pgCtl = await request.log.append(({ descriptor }) =>
      this.processes.start({
        executable: request.pgCtl,
        args: ['stop', '-D', request.clusterDir, '-m', 'fast', '-w', '-t', String(seconds)],
        cwd: dirname(request.clusterDir),
        env: { LC_ALL: 'C' },
        stdio: { stdin: 'ignore', stdout: descriptor, stderr: descriptor },
        cancellation: {
          signal: request.signal,
          graceMs: STOP_CANCEL_GRACE_MS,
          killWaitMs: STOP_CANCEL_KILL_WAIT_MS,
        },
      }),
    );
    await pgCtl.completion;
  }
}

interface RecordedServer {
  readonly pid: number;
  readonly dataDir: string;
  readonly startedAt: number;
}

type LockFile =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unsafe' }
  | { readonly kind: 'read'; readonly content: string; readonly modifiedAt: number };

async function readLockFile(path: string): Promise<LockFile> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unsafe' };
  }
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > MAX_LOCK_FILE_BYTES
    ) {
      return { kind: 'unsafe' };
    }
    const buffer = Buffer.alloc(MAX_LOCK_FILE_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return {
      kind: 'read',
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      modifiedAt: metadata.mtimeMs / 1000,
    };
  } finally {
    await file.close();
  }
}

function ownedByAnotherUser(observation: IdentityObservation): boolean {
  if (observation.kind === 'captured') {
    return observation.identity.uid !== process.getuid?.();
  }
  return observation.kind === 'restricted' && observation.uid !== process.getuid?.();
}

function parseRecordedServer(content: string): RecordedServer | undefined {
  const [pid, dataDir, startedAt] = content.split('\n');
  if (
    pid === undefined ||
    dataDir === undefined ||
    startedAt === undefined ||
    !/^[1-9]\d{0,9}$/u.test(pid) ||
    !/^\d{1,12}$/u.test(startedAt)
  ) {
    return undefined;
  }
  return { pid: Number(pid), dataDir, startedAt: Number(startedAt) };
}

async function discardStaleLock(clusterDir: string): Promise<LockRecovery> {
  const path = join(clusterDir, LOCK_FILE);
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      return refused(`the stale lock file ${path} could not be removed`);
    }
  }
  return { kind: 'released' };
}

function refusalDetail(
  clusterDir: string,
  lock: Extract<ClusterLock, { readonly kind: 'running' | 'uncertain' }>,
) {
  if (lock.kind === 'running') {
    return `the earlier PostgreSQL server (PID ${String(lock.pid)}) of ${clusterDir} did not stop`;
  }
  return (
    `the lock file ${join(clusterDir, LOCK_FILE)} was left in place because ${lock.reason}; ` +
    `no signal was sent. If no PostgreSQL server uses ${clusterDir}, remove the lock file and start again`
  );
}

const refused = (detail: string): LockRecovery => ({ kind: 'refused', detail });

const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
