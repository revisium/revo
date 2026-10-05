import { randomBytes } from 'node:crypto';
import {
  constants,
  type FileHandle,
  lstat,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { join } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { ManagedProcessService } from '../processes/managed-process.service.js';
import type { OwnedProcess, ProcessCompletion } from '../processes/managed-process.types.js';
import type { StartupProgressFacade } from '../startup-progress/index.js';
import { loadEmbeddedPostgresBinaries } from './embedded-postgres-binaries.js';
import type { EmbeddedPostgresLog } from './embedded-postgres-log.js';
import {
  type EmbeddedPostgresBinaries,
  EmbeddedPostgresError,
  type PrepareEmbeddedPostgresRequest,
  type PreparedEmbeddedPostgres,
} from './embedded-postgres.types.js';

const FILE_MODE = 0o600;
const MAX_SMALL_FILE = 4096;
const CANCEL_GRACE_MS = 1000;
const CANCEL_KILL_WAIT_MS = 5000;
const CREDENTIAL_FORMAT = /^[A-Za-z0-9_-]{32}$/u;
const STAGED_CLUSTER_PREFIX = '.postgres-initdb';

@Injectable()
export class EmbeddedPostgresPreparationService {
  constructor(
    @Inject(ManagedProcessService)
    private readonly processes: ManagedProcessService = new ManagedProcessService(),
  ) {}

  bind(canonicalDataDir: string, progress: StartupProgressFacade, log: EmbeddedPostgresLog) {
    return new OwnedEmbeddedPostgresPreparation(this.processes, canonicalDataDir, progress, log);
  }
}

export class OwnedEmbeddedPostgresPreparation {
  private active: Promise<PreparedEmbeddedPostgres> | undefined;
  private controller: AbortController | undefined;
  private closing = false;
  private childCompletion: Promise<void> | undefined;
  private stopFailure = false;

  constructor(
    private readonly processes: ManagedProcessService,
    private readonly canonicalDataDir: string,
    private readonly progress: StartupProgressFacade,
    private readonly log: EmbeddedPostgresLog,
  ) {}

  prepare(request: PrepareEmbeddedPostgresRequest): Promise<PreparedEmbeddedPostgres> {
    if (this.closing) {
      return Promise.reject(new EmbeddedPostgresError('cancelled'));
    }
    if (this.active) {
      return this.active;
    }
    if (this.childCompletion) {
      return Promise.reject(new EmbeddedPostgresError('cancelled'));
    }
    const preparation = this.perform(request).finally(() => {
      this.active = undefined;
      this.controller = undefined;
    });
    this.active = preparation;
    return preparation;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.controller?.abort();
    try {
      await this.active;
    } catch {
      // Closing drains owned work; its caller already observes preparation failure.
    }
    if (this.childCompletion || this.stopFailure) {
      throw new EmbeddedPostgresError('process');
    }
  }

  async settled(): Promise<void> {
    await this.active?.catch(() => undefined);
    await this.childCompletion;
  }

  private async perform(
    request: PrepareEmbeddedPostgresRequest,
  ): Promise<PreparedEmbeddedPostgres> {
    validateRequest(request);
    if (typeof process.getuid !== 'function' || process.getuid() === 0) {
      throw new EmbeddedPostgresError('invalid');
    }
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, request.timeoutMs);
    try {
      return await this.prepareCluster(controller.signal);
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', abort);
    }
  }

  private async prepareCluster(signal: AbortSignal): Promise<PreparedEmbeddedPostgres> {
    const binaries = await loadEmbeddedPostgresBinaries();
    rejectCancellation(signal);
    const layout = clusterLayout(this.canonicalDataDir);
    const state = await inspectState(layout);
    rejectCancellation(signal);
    if (state.kind === 'ready') {
      await discardAbandonedStagedClusters(layout);
      return prepared(layout, binaries, false);
    }
    if (state.kind === 'invalid') {
      await this.log.record(state.detail);
      throw new EmbeddedPostgresError('invalid', false, undefined, { detail: state.detail });
    }

    let phase = 'postgres-binary-prepare';
    try {
      await this.progress.start(phase);
      rejectCancellation(signal);
      if (state.cluster === 'empty') {
        await rmdir(layout.cluster);
      }
      if (state.credential !== 'valid') {
        await commitCredential(layout);
      }
      rejectCancellation(signal);
      const stagedCluster = await mkdtemp(join(layout.dataDir, `${STAGED_CLUSTER_PREFIX}-`));
      await discardAbandonedStagedClusters(layout, stagedCluster);
      await this.progress.complete(phase);
      phase = 'postgres-initialization';
      await this.progress.start(phase);
      rejectCancellation(signal);
      await this.initializeStagedCluster(binaries.initdb, layout, stagedCluster, signal);
      if ((await inspectCluster(stagedCluster)) !== 'ready') {
        throw new EmbeddedPostgresError('invalid');
      }
      rejectCancellation(signal);
      await commitCluster(layout, stagedCluster);
      await this.progress.complete(phase);
      rejectCancellation(signal);
      return prepared(layout, binaries, true);
    } catch (error) {
      const primary = (
        error instanceof EmbeddedPostgresError ? error : new EmbeddedPostgresError('process')
      ).withLog(this.log.path);
      try {
        await this.progress.fail(phase, {
          code: `POSTGRES_${primary.reason.toUpperCase()}`,
          logPath: this.log.path,
        });
      } catch {
        throw primary.withProgressFailure();
      }
      throw primary;
    }
  }

  private async initializeStagedCluster(
    initdb: string,
    layout: ClusterLayout,
    stagedCluster: string,
    signal: AbortSignal,
  ): Promise<void> {
    const child = await this.log.append(({ descriptor }) =>
      this.processes.start({
        executable: initdb,
        args: [
          `--pgdata=${stagedCluster}`,
          `--pwfile=${layout.credential}`,
          '--encoding=UTF8',
          '--locale=C',
          '--auth=scram-sha-256',
          '--username=postgres',
          '--no-instructions',
        ],
        cwd: this.canonicalDataDir,
        env: { LC_ALL: 'C' },
        stdio: { stdin: 'ignore', stdout: descriptor, stderr: descriptor },
        cancellation: { signal, graceMs: CANCEL_GRACE_MS, killWaitMs: CANCEL_KILL_WAIT_MS },
      }),
    );
    this.observeChild(child);
    const completion = await this.awaitCompletion(child);
    if (completion.exitCode !== 0 || completion.signal !== null) {
      throw new EmbeddedPostgresError(signal.aborted ? 'cancelled' : 'process', false, completion);
    }
  }

  private observeChild(child: OwnedProcess) {
    const observed = child.completion.then(() => undefined);
    this.childCompletion = observed;
    void observed.finally(() => {
      if (this.childCompletion === observed) {
        this.childCompletion = undefined;
      }
    });
  }

  private async awaitCompletion(child: OwnedProcess) {
    if (!child.cancellationResult) {
      return child.completion;
    }
    const cancellation = child.cancellationResult.then((result) => {
      if (result.kind === 'failed') {
        this.stopFailure = true;
        throw new EmbeddedPostgresError('process');
      }
      return new Promise<ProcessCompletion>(() => undefined);
    });
    return Promise.race([child.completion, cancellation]);
  }
}

interface ClusterLayout {
  readonly dataDir: string;
  readonly cluster: string;
  readonly credential: string;
  readonly stagedCredential: string;
}

type CredentialState = 'missing' | 'valid' | 'malformed' | 'unsafe';
type ClusterState = 'missing' | 'empty' | 'ready' | 'unusable';
type PreparationState =
  | { readonly kind: 'ready' }
  | { readonly kind: 'invalid'; readonly detail: string }
  | {
      readonly kind: 'new';
      readonly credential: Exclude<CredentialState, 'unsafe'>;
      readonly cluster: Extract<ClusterState, 'missing' | 'empty'>;
    };

const clusterLayout = (dataDir: string): ClusterLayout => ({
  dataDir,
  cluster: join(dataDir, 'postgres'),
  credential: join(dataDir, 'postgres-password'),
  stagedCredential: join(dataDir, '.postgres-password.tmp'),
});

function validateRequest(request: PrepareEmbeddedPostgresRequest) {
  if (
    request.signal.aborted ||
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > 2_147_483_647
  ) {
    throw new EmbeddedPostgresError(request.signal.aborted ? 'cancelled' : 'invalid');
  }
}

async function inspectState(layout: ClusterLayout): Promise<PreparationState> {
  const [credential, cluster] = await Promise.all([
    inspectCredential(layout.credential),
    inspectCluster(layout.cluster),
  ]);
  if (credential === 'unsafe') {
    return invalid(`the credential ${layout.credential} is not a private regular file`);
  }
  if (cluster === 'ready') {
    return credential === 'valid'
      ? { kind: 'ready' }
      : invalid(`the credential ${layout.credential} of the existing cluster is unusable`);
  }
  if (cluster === 'unusable') {
    return invalid(`the existing cluster ${layout.cluster} is incomplete and was left untouched`);
  }
  return { kind: 'new', credential, cluster };
}

const invalid = (detail: string) => ({ kind: 'invalid' as const, detail });

async function inspectCredential(path: string): Promise<CredentialState> {
  const kind = await pathKind(path);
  if (kind === 'missing') {
    return 'missing';
  }
  if (kind !== 'file') {
    return 'unsafe';
  }
  try {
    return CREDENTIAL_FORMAT.test(await readPrivateFile(path)) ? 'valid' : 'malformed';
  } catch {
    return 'unsafe';
  }
}

async function inspectCluster(path: string): Promise<ClusterState> {
  const kind = await pathKind(path);
  if (kind === 'missing') {
    return 'missing';
  }
  if (kind !== 'directory') {
    return 'unusable';
  }
  try {
    await validateDirectory(path);
    if ((await readdir(path)).length === 0) {
      return 'empty';
    }
    const version = (await readPrivateFile(join(path, 'PG_VERSION'))).trim();
    const artifacts = await Promise.all(
      ['base', 'global', join('global', 'pg_control'), 'postgresql.conf'].map((name) =>
        pathKind(join(path, name)),
      ),
    );
    const structurallyReady =
      version === '17' &&
      artifacts[0] === 'directory' &&
      artifacts[1] === 'directory' &&
      artifacts[2] === 'file' &&
      artifacts[3] === 'file';
    if (!structurallyReady) {
      return 'unusable';
    }
    await Promise.all([
      validateDirectory(join(path, 'base')),
      validateDirectory(join(path, 'global')),
      validatePrivateFile(join(path, 'global', 'pg_control')),
      validatePrivateFile(join(path, 'postgresql.conf')),
    ]);
    return 'ready';
  } catch {
    return 'unusable';
  }
}

// Removal is best-effort because an initdb orphaned by a killed supervisor may still write there.
// It runs only after the current staging directory exists, so that directory cannot reuse the inode
// from which PostgreSQL derives the orphan's shared memory key.
async function discardAbandonedStagedClusters(layout: ClusterLayout, current?: string) {
  const entries = await readdir(layout.dataDir).catch(() => []);
  await Promise.allSettled(
    entries
      .filter((name) => name.startsWith(STAGED_CLUSTER_PREFIX))
      .map((name) => join(layout.dataDir, name))
      .filter((path) => path !== current)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
}

async function commitCredential(layout: ClusterLayout) {
  await rm(layout.stagedCredential, { force: true });
  const file = await open(layout.stagedCredential, 'wx', FILE_MODE);
  try {
    await file.writeFile(randomBytes(24).toString('base64url'), 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(layout.stagedCredential, layout.credential);
  await syncDirectory(layout.dataDir);
}

async function commitCluster(layout: ClusterLayout, stagedCluster: string) {
  await rename(stagedCluster, layout.cluster);
  await syncDirectory(layout.dataDir);
}

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function pathKind(path: string) {
  try {
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      return 'directory' as const;
    }
    if (stat.isFile()) {
      return 'file' as const;
    }
    return 'other' as const;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return 'missing' as const;
    }
    throw new EmbeddedPostgresError('invalid');
  }
}

async function validateDirectory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new EmbeddedPostgresError('invalid');
  }
}

async function readPrivateFile(path: string) {
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > MAX_SMALL_FILE
    ) {
      throw new EmbeddedPostgresError('invalid');
    }
    const content = Buffer.alloc(MAX_SMALL_FILE + 1);
    const { bytesRead } = await file.read(content, 0, content.length, 0);
    if (bytesRead > MAX_SMALL_FILE) {
      throw new EmbeddedPostgresError('invalid');
    }
    return content.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file?.close();
  }
}

export const readEmbeddedPostgresCredential = (canonicalDataDir: string) =>
  readPrivateFile(clusterLayout(canonicalDataDir).credential);

async function validatePrivateFile(path: string) {
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new EmbeddedPostgresError('invalid');
    }
  } finally {
    await file?.close();
  }
}

const prepared = (layout: ClusterLayout, binaries: EmbeddedPostgresBinaries, created: boolean) =>
  Object.freeze({
    clusterDir: layout.cluster,
    postgres: binaries.postgres,
    pgCtl: binaries.pgCtl,
    created,
    majorVersion: 17 as const,
  });

function rejectCancellation(signal: AbortSignal) {
  if (signal.aborted) {
    throw new EmbeddedPostgresError('cancelled');
  }
}

const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
