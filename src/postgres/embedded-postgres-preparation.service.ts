import { randomBytes } from 'node:crypto';
import { constants, type FileHandle, lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { ManagedProcessService } from '../processes/managed-process.service.js';
import type { OwnedProcess, ProcessCompletion } from '../processes/managed-process.types.js';
import type { StartupProgressFacade } from '../startup-progress/index.js';
import { loadEmbeddedPostgresBinaries } from './embedded-postgres-binaries.js';
import {
  EmbeddedPostgresError,
  type PrepareEmbeddedPostgresRequest,
  type PreparedEmbeddedPostgres,
} from './embedded-postgres.types.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_SMALL_FILE = 4096;
const CANCEL_GRACE_MS = 1000;
const CANCEL_KILL_WAIT_MS = 5000;

@Injectable()
export class EmbeddedPostgresPreparationService {
  constructor(
    @Inject(ManagedProcessService)
    private readonly processes: ManagedProcessService = new ManagedProcessService(),
  ) {}

  bind(canonicalDataDir: string, progress: StartupProgressFacade) {
    return new OwnedEmbeddedPostgresPreparation(this.processes, canonicalDataDir, progress);
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
    if (this.active || this.childCompletion || this.stopFailure) {
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
    const clusterDir = join(this.canonicalDataDir, 'postgres');
    const passwordPath = join(this.canonicalDataDir, 'postgres-password');
    const state = await inspectState(clusterDir, passwordPath);
    rejectCancellation(signal);
    if (state === 'ready') {
      return prepared(clusterDir, binaries.postgres, false);
    }
    if (state === 'invalid') {
      throw new EmbeddedPostgresError('invalid');
    }

    let phase = 'postgres-binary-prepare';
    try {
      await this.progress.start(phase);
      rejectCancellation(signal);
      await mkdir(clusterDir, { mode: DIRECTORY_MODE });
      rejectCancellation(signal);
      await createPassword(passwordPath);
      rejectCancellation(signal);
      await this.progress.complete(phase);
      phase = 'postgres-initialization';
      await this.progress.start(phase);
      rejectCancellation(signal);
      const child = await this.processes.start({
        executable: binaries.initdb,
        args: [
          `--pgdata=${clusterDir}`,
          `--pwfile=${passwordPath}`,
          '--encoding=UTF8',
          '--locale=C',
          '--auth=scram-sha-256',
          '--username=postgres',
          '--no-clean',
          '--no-instructions',
        ],
        cwd: this.canonicalDataDir,
        env: { LC_ALL: 'C' },
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        cancellation: { signal, graceMs: CANCEL_GRACE_MS, killWaitMs: CANCEL_KILL_WAIT_MS },
      });
      child.stdout?.resume();
      child.stderr?.resume();
      this.observeChild(child);
      const completion = await this.awaitCompletion(child);
      if (completion.exitCode !== 0 || completion.signal !== null) {
        throw new EmbeddedPostgresError(
          signal.aborted ? 'cancelled' : 'process',
          false,
          completion,
        );
      }
      if ((await inspectState(clusterDir, passwordPath)) !== 'ready') {
        throw new EmbeddedPostgresError('invalid');
      }
      rejectCancellation(signal);
      await this.progress.complete(phase);
      rejectCancellation(signal);
      return prepared(clusterDir, binaries.postgres, true);
    } catch (error) {
      const primary =
        error instanceof EmbeddedPostgresError ? error : new EmbeddedPostgresError('process');
      try {
        await this.progress.fail(phase, { code: `POSTGRES_${primary.reason.toUpperCase()}` });
      } catch {
        throw new EmbeddedPostgresError(primary.reason, true, primary.observedCompletion);
      }
      throw primary;
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

async function inspectState(clusterDir: string, passwordPath: string) {
  const [cluster, credential] = await Promise.all([pathKind(clusterDir), pathKind(passwordPath)]);
  if (cluster === 'missing' && credential === 'missing') {
    return 'new' as const;
  }
  if (cluster !== 'directory' || credential !== 'file') {
    return 'invalid' as const;
  }
  try {
    await validateDirectory(clusterDir);
    const password = await readPrivateFile(passwordPath);
    if (!/^[A-Za-z0-9_-]{32}$/u.test(password)) {
      return 'invalid' as const;
    }
    const version = (await readPrivateFile(join(clusterDir, 'PG_VERSION'))).trim();
    const artifacts = await Promise.all(
      ['base', 'global', 'postgresql.conf'].map((name) => pathKind(join(clusterDir, name))),
    );
    const structurallyReady =
      version === '17' &&
      artifacts[0] === 'directory' &&
      artifacts[1] === 'directory' &&
      artifacts[2] === 'file';
    if (!structurallyReady) {
      return 'invalid' as const;
    }
    await Promise.all([
      validateDirectory(join(clusterDir, 'base')),
      validateDirectory(join(clusterDir, 'global')),
      validatePrivateFile(join(clusterDir, 'postgresql.conf')),
    ]);
    return 'ready' as const;
  } catch {
    return 'invalid' as const;
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
  readPrivateFile(join(canonicalDataDir, 'postgres-password'));

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

async function createPassword(path: string) {
  const file = await open(path, 'wx', FILE_MODE);
  try {
    await file.writeFile(randomBytes(24).toString('base64url'), 'utf8');
  } finally {
    await file.close();
  }
}

const prepared = (clusterDir: string, postgres: string, created: boolean) =>
  Object.freeze({ clusterDir, postgres, created, majorVersion: 17 as const });

function rejectCancellation(signal: AbortSignal) {
  if (signal.aborted) {
    throw new EmbeddedPostgresError('cancelled');
  }
}

const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
