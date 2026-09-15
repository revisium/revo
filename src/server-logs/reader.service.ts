import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parseLifecycleDocument } from './document.js';
import {
  MAX_SERVER_LIFECYCLE_DOCUMENT_BYTES,
  SERVER_LIFECYCLE_FILE,
  SERVER_LIFECYCLE_READER_BYTES,
  type ServerLifecycleConfiguration,
  type ServerLifecycleEvent,
} from './server-lifecycle.types.js';

export type ServerLifecycleReadResult =
  | {
      readonly kind: 'missing';
      readonly cursor: number;
      readonly events: readonly [];
      readonly reset: false;
    }
  | {
      readonly kind: 'invalid';
      readonly cursor: number;
      readonly events: readonly [];
      readonly reset: false;
    }
  | {
      readonly kind: 'ready';
      readonly cursor: number;
      readonly events: readonly ServerLifecycleEvent[];
      readonly reset: boolean;
    };

/** Reads one pinned lifecycle identity without opening, recovering, or changing its store. */
export class ServerLifecycleReader {
  private readonly path: string;

  private constructor(private readonly configuration: ServerLifecycleConfiguration) {
    const digest = createHash('sha256')
      .update(configuration.canonicalDataDir, 'utf8')
      .digest('hex');
    this.path = join(configuration.logDir, configuration.channel, digest, SERVER_LIFECYCLE_FILE);
  }

  static async open(configuration: ServerLifecycleConfiguration): Promise<ServerLifecycleReader> {
    const canonicalDataDir = await canonicalIdentity(configuration.canonicalDataDir);
    return new ServerLifecycleReader({ ...configuration, canonicalDataDir });
  }

  async read(afterSequence = 0): Promise<ServerLifecycleReadResult> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      return { kind: 'invalid', cursor: 0, events: [], reset: false };
    }
    const document = await readDocument(this.path);
    if (document.kind === 'missing' || document.kind === 'invalid') {
      return { ...document, cursor: afterSequence, events: [], reset: false };
    }
    const events = document.events;
    const last = events.at(-1)?.sequence ?? afterSequence;
    const first = events[0]?.sequence;
    const reset =
      afterSequence > 0 &&
      ((first !== undefined && first > afterSequence + 1) || last < afterSequence);
    return {
      kind: 'ready',
      cursor: last,
      events: reset ? events : events.filter((event) => event.sequence > afterSequence),
      reset,
    };
  }
}

type DocumentRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ready'; readonly events: readonly ServerLifecycleEvent[] };

async function canonicalIdentity(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function readDocument(path: string): Promise<DocumentRead> {
  const parents = await validateParents(path);
  if (parents !== 'ready') {
    return { kind: parents };
  }
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
      !safeDocumentFile(descriptor, pathname) ||
      descriptor.size > MAX_SERVER_LIFECYCLE_DOCUMENT_BYTES
    ) {
      return { kind: 'invalid' };
    }
    const content = await readBounded(file);
    const document = content === undefined ? undefined : parseLifecycleDocument(content);
    return document ? { kind: 'ready', events: document.events } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function validateParents(path: string): Promise<'ready' | 'missing' | 'invalid'> {
  let missing = false;
  for (let current = dirname(path); current !== dirname(current); current = dirname(current)) {
    // oxlint-disable-next-line no-await-in-loop -- parent checks must cover every ancestor
    const entry = await lstat(current).catch((error: unknown) =>
      errorCode(error) === 'ENOENT' ? undefined : null,
    );
    if (entry === null || (entry && !entry.isDirectory())) {
      return 'invalid';
    }
    missing ||= entry === undefined;
  }
  return missing ? 'missing' : 'ready';
}

async function readBounded(file: FileHandle): Promise<string | undefined> {
  const buffer = Buffer.alloc(SERVER_LIFECYCLE_READER_BYTES);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  return bytesRead === buffer.length ? undefined : buffer.subarray(0, bytesRead).toString('utf8');
}

const privateOwned = (uid: number, mode: number) =>
  typeof process.getuid === 'function' && uid === process.getuid() && (mode & 0o077) === 0;
const safeDocumentFile = (descriptor: Stats, pathname: Stats) =>
  descriptor.isFile() &&
  pathname.isFile() &&
  privateOwned(descriptor.uid, descriptor.mode) &&
  descriptor.nlink === 1 &&
  pathname.nlink === 1 &&
  descriptor.dev === pathname.dev &&
  descriptor.ino === pathname.ino;
const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
