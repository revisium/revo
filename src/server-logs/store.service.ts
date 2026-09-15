import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  createLifecycleEvent,
  parseLifecycleDocument,
  serializeLifecycleDocument,
} from './document.js';
import {
  MAX_SERVER_LIFECYCLE_DOCUMENT_BYTES,
  SERVER_LIFECYCLE_FILE,
  SERVER_LIFECYCLE_MAX_PENDING_WRITES,
  SERVER_LIFECYCLE_READER_BYTES,
  SERVER_LIFECYCLE_RETAIN,
  SERVER_LIFECYCLE_TEMP_FILE,
  ServerLifecycleError,
  type ServerLifecycleCode,
  type ServerLifecycleConfiguration,
  type ServerLifecycleEvent,
  type ServerLifecycleCorePhase,
  type ServerLifecycleSink,
} from './server-lifecycle.types.js';

interface FileRead {
  readonly kind: 'missing' | 'valid' | 'invalid';
  readonly events?: readonly ServerLifecycleEvent[];
}

export class ServerLifecycleStore implements ServerLifecycleSink {
  private readonly targetPath: string;
  private readonly temporaryPath: string;
  private readonly now: () => number;
  private events: readonly ServerLifecycleEvent[] = [];
  private sequence = 1;
  private queue = Promise.resolve();
  private pending = 0;
  private closed = false;
  private disabled = false;

  private constructor(private readonly configuration: ServerLifecycleConfiguration) {
    validateConfiguration(configuration);
    const digest = createHash('sha256')
      .update(configuration.canonicalDataDir, 'utf8')
      .digest('hex');
    const directory = join(configuration.logDir, configuration.channel, digest);
    this.targetPath = join(directory, SERVER_LIFECYCLE_FILE);
    this.temporaryPath = join(directory, SERVER_LIFECYCLE_TEMP_FILE);
    this.now = configuration.now ?? Date.now;
  }

  static async open(configuration: ServerLifecycleConfiguration): Promise<ServerLifecycleStore> {
    try {
      const store = new ServerLifecycleStore(configuration);
      await store.initialize();
      return store;
    } catch (error) {
      throw error instanceof ServerLifecycleError ? error : new ServerLifecycleError('io');
    }
  }

  async emit(code: ServerLifecycleCode, corePhase?: ServerLifecycleCorePhase): Promise<void> {
    if (this.closed || this.disabled) {
      return;
    }
    if (this.pending >= SERVER_LIFECYCLE_MAX_PENDING_WRITES) {
      throw new ServerLifecycleError('limit');
    }
    this.pending += 1;
    const operation = this.queue.then(async () => {
      if (this.disabled) {
        return;
      }
      if (!Number.isSafeInteger(this.sequence) || this.sequence >= Number.MAX_SAFE_INTEGER) {
        this.disabled = true;
        throw new ServerLifecycleError('limit');
      }
      const event = createLifecycleEvent(this.sequence, this.now(), code, corePhase);
      if (!event) {
        this.disabled = true;
        throw new ServerLifecycleError('invalid');
      }
      const retained = [...this.events, event].slice(-SERVER_LIFECYCLE_RETAIN);
      await this.persist(retained);
      this.events = retained;
      this.sequence = event.sequence + 1;
    });
    this.queue = operation.then(
      () => {
        this.pending -= 1;
      },
      () => {
        this.pending -= 1;
        this.disabled = true;
      },
    );
    return operation;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }

  private async initialize(): Promise<void> {
    const directory = dirname(this.targetPath);
    await ensurePrivateDirectory(this.configuration.logDir);
    await ensurePrivateDirectory(join(this.configuration.logDir, this.configuration.channel));
    await ensurePrivateDirectory(directory);

    const target = await readFile(this.targetPath);
    const temporary = await readFile(this.temporaryPath);
    if (target.kind === 'invalid' || temporary.kind === 'invalid') {
      throw new ServerLifecycleError('unsafe');
    }
    const temporarySequence = lastSequence(temporary.events);
    const targetSequence = lastSequence(target.events);
    if (
      temporary.kind === 'valid' &&
      (target.kind === 'missing' || temporarySequence > targetSequence)
    ) {
      await rename(this.temporaryPath, this.targetPath);
      this.events = temporary.events ?? [];
    } else {
      await (temporary.kind === 'valid' ? unlink(this.temporaryPath) : undefined);
      this.events = target.events ?? [];
    }
    const last = lastSequence(this.events);
    if (!Number.isSafeInteger(last) || last >= Number.MAX_SAFE_INTEGER) {
      throw new ServerLifecycleError('limit');
    }
    this.sequence = last + 1;
  }

  private async persist(events: readonly ServerLifecycleEvent[]): Promise<void> {
    let serialized: string;
    try {
      serialized = serializeLifecycleDocument(events);
    } catch {
      this.disabled = true;
      throw new ServerLifecycleError('limit');
    }
    let file: FileHandle | undefined;
    let temporaryOwned = false;
    try {
      file = await open(
        this.temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      temporaryOwned = true;
      await file.writeFile(serialized, 'utf8');
      await file.sync();
      await file.close();
      file = undefined;
      await rename(this.temporaryPath, this.targetPath);
    } catch (error) {
      await file?.close().catch(() => undefined);
      await (temporaryOwned ? unlink(this.temporaryPath).catch(() => undefined) : undefined);
      this.disabled = true;
      const reason = errorCode(error) === 'EFBIG' ? 'limit' : 'io';
      throw error instanceof ServerLifecycleError ? error : new ServerLifecycleError(reason);
    }
  }
}

export async function openServerLifecycleStore(
  configuration: ServerLifecycleConfiguration,
): Promise<ServerLifecycleStore | undefined> {
  try {
    return await ServerLifecycleStore.open(configuration);
  } catch {
    return undefined;
  }
}

export function serverLifecyclePath(configuration: ServerLifecycleConfiguration): string {
  validateConfiguration(configuration);
  const digest = createHash('sha256').update(configuration.canonicalDataDir, 'utf8').digest('hex');
  return join(configuration.logDir, configuration.channel, digest, SERVER_LIFECYCLE_FILE);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await validateParents(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || !privateOwned(metadata.uid, metadata.mode)) {
    throw new ServerLifecycleError('unsafe');
  }
}

async function validateParents(path: string): Promise<void> {
  const parents: string[] = [];
  for (let current = dirname(path); current !== dirname(current); current = dirname(current)) {
    parents.push(current);
  }
  const metadata = await Promise.all(
    parents.map((current) =>
      lstat(current).catch((error: unknown) => (errorCode(error) === 'ENOENT' ? undefined : null)),
    ),
  );
  if (metadata.some((entry) => entry === null || (entry && !entry.isDirectory()))) {
    throw new ServerLifecycleError('unsafe');
  }
}

async function readFile(path: string): Promise<FileRead> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
  }
  try {
    const descriptor = await file.stat();
    const pathname = await lstat(path);
    if (
      !descriptor.isFile() ||
      !privateOwned(descriptor.uid, descriptor.mode) ||
      descriptor.nlink !== 1 ||
      !pathname.isFile() ||
      pathname.nlink !== 1 ||
      descriptor.dev !== pathname.dev ||
      descriptor.ino !== pathname.ino ||
      descriptor.size > MAX_SERVER_LIFECYCLE_DOCUMENT_BYTES
    ) {
      return { kind: 'invalid' };
    }
    const content = await readBounded(file);
    const document = parseLifecycleDocument(content);
    return document ? { kind: 'valid', events: document.events } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function readBounded(file: FileHandle): Promise<string | undefined> {
  const buffer = Buffer.alloc(SERVER_LIFECYCLE_READER_BYTES);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  return bytesRead === buffer.length ? undefined : buffer.subarray(0, bytesRead).toString('utf8');
}

function validateConfiguration(configuration: ServerLifecycleConfiguration): void {
  if (
    !configuration ||
    (configuration.channel !== 'stable' && configuration.channel !== 'alpha') ||
    !absolute(configuration.logDir) ||
    !absolute(configuration.canonicalDataDir)
  ) {
    throw new ServerLifecycleError('invalid');
  }
}

function absolute(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.includes('\0');
}

const lastSequence = (events: readonly ServerLifecycleEvent[] | undefined): number =>
  events?.at(-1)?.sequence ?? 0;

const privateOwned = (uid: number, mode: number) =>
  typeof process.getuid === 'function' && uid === process.getuid() && (mode & 0o077) === 0;
const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
