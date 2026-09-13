import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { parseProgressEvent, type ProgressEvent } from '../progress/index.js';
import {
  MAX_NONTERMINAL_TRANSITIONS,
  MAX_STARTUP_PROGRESS_BYTES,
  STARTUP_PROGRESS_FILE,
  STARTUP_PROGRESS_SCHEMA_VERSION,
  TERMINAL_PROGRESS_RESERVE_BYTES,
  StartupProgressError,
  type StartupProgressCursor,
  type StartupProgressRead,
} from './startup-progress.types.js';

interface ProgressDocument {
  readonly schemaVersion: typeof STARTUP_PROGRESS_SCHEMA_VERSION;
  readonly operationId: string;
  readonly events: readonly ProgressEvent[];
}

@Injectable()
export class StartupProgressJournalWriter {
  async write(
    canonicalDataDir: string,
    operationId: string,
    events: readonly ProgressEvent[],
  ): Promise<void> {
    const document = { schemaVersion: STARTUP_PROGRESS_SCHEMA_VERSION, operationId, events };
    const serialized = `${JSON.stringify(document)}\n`;
    const terminal = events.at(-1)?.status === 'failed' || events.at(-1)?.status === 'ready';
    const transitions = events.filter((event) => event.status !== 'progress').length;
    if (
      Buffer.byteLength(serialized) > MAX_STARTUP_PROGRESS_BYTES ||
      (!terminal &&
        Buffer.byteLength(serialized) + TERMINAL_PROGRESS_RESERVE_BYTES >
          MAX_STARTUP_PROGRESS_BYTES) ||
      (!terminal && transitions > MAX_NONTERMINAL_TRANSITIONS) ||
      (terminal && transitions > MAX_NONTERMINAL_TRANSITIONS + 1) ||
      (terminal &&
        Buffer.byteLength(`${JSON.stringify(events.at(-1))}\n`) > TERMINAL_PROGRESS_RESERVE_BYTES)
    ) {
      throw new StartupProgressError('limit');
    }
    if (!parseDocument(serialized)) {
      throw new StartupProgressError('invalid');
    }
    const temporaryPath = join(
      canonicalDataDir,
      `.revo-progress.${randomBytes(16).toString('hex')}.tmp`,
    );
    try {
      const file = await open(temporaryPath, 'wx', 0o600);
      try {
        await file.writeFile(serialized, 'utf8');
      } finally {
        await file.close();
      }
      await rename(temporaryPath, join(canonicalDataDir, STARTUP_PROGRESS_FILE));
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof StartupProgressError) {
        throw error;
      }
      throw new StartupProgressError('io');
    }
  }
}

@Injectable()
export class StartupProgressDiscoveryService {
  async read(dataDir: string, cursor: StartupProgressCursor): Promise<StartupProgressRead> {
    if (
      !/^[0-9a-f]{32}$/u.test(cursor.operationId) ||
      !Number.isSafeInteger(cursor.sequence) ||
      cursor.sequence < 0
    ) {
      return { kind: 'invalid' };
    }
    let canonicalDataDir: string;
    try {
      canonicalDataDir = await realpath(dataDir);
      const directory = await stat(canonicalDataDir);
      if (!directory.isDirectory() || !ownedPrivate(directory.uid, directory.mode)) {
        return { kind: 'unavailable' };
      }
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unavailable' };
    }
    let file: FileHandle;
    try {
      file = await open(
        join(canonicalDataDir, STARTUP_PROGRESS_FILE),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unavailable' };
    }
    try {
      const metadata = await file.stat();
      if (
        !metadata.isFile() ||
        !ownedPrivate(metadata.uid, metadata.mode) ||
        metadata.size > MAX_STARTUP_PROGRESS_BYTES
      ) {
        return { kind: 'invalid' };
      }
      const document = parseDocument(await readBounded(file));
      if (!document) {
        return { kind: 'invalid' };
      }
      if (document.operationId !== cursor.operationId) {
        return { kind: 'operation-changed', operationId: document.operationId };
      }
      return {
        kind: 'events',
        operationId: document.operationId,
        events: Object.freeze(document.events.filter((event) => event.sequence > cursor.sequence)),
      };
    } catch {
      return { kind: 'invalid' };
    } finally {
      await file.close().catch(() => undefined);
    }
  }
}

function parseDocument(content: string | undefined): ProgressDocument | undefined {
  if (!content) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(content);
    if (
      !record(value) ||
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, 'en'))
        .join(',') !== 'events,operationId,schemaVersion' ||
      value.schemaVersion !== STARTUP_PROGRESS_SCHEMA_VERSION ||
      typeof value.operationId !== 'string' ||
      !Array.isArray(value.events)
    ) {
      return undefined;
    }
    const events: ProgressEvent[] = [];
    for (const candidate of value.events) {
      const event = parseProgressEvent(candidate);
      if (!event) {
        return undefined;
      }
      events.push(event);
    }
    if (!/^[0-9a-f]{32}$/u.test(value.operationId) || !validOrder(events, value.operationId)) {
      return undefined;
    }
    return {
      schemaVersion: STARTUP_PROGRESS_SCHEMA_VERSION,
      operationId: value.operationId,
      events,
    };
  } catch {
    return undefined;
  }
}

function validOrder(events: readonly ProgressEvent[], operationId: string) {
  let sequence = 0;
  let elapsed = 0;
  let terminal = false;
  const validEvents = events.every((event) => {
    const valid =
      event.operationId === operationId &&
      event.sequence > sequence &&
      event.elapsedMs >= elapsed &&
      !terminal;
    sequence = event.sequence;
    elapsed = event.elapsedMs;
    terminal = event.status === 'failed' || event.status === 'ready';
    return valid;
  });
  const transitions = events.filter((event) => event.status !== 'progress').length;
  const progress = events.filter((event) => event.status === 'progress').length;
  return (
    validEvents &&
    progress <= 1 &&
    transitions <=
      (events.at(-1)?.status === 'failed' || events.at(-1)?.status === 'ready'
        ? MAX_NONTERMINAL_TRANSITIONS + 1
        : MAX_NONTERMINAL_TRANSITIONS)
  );
}

async function readBounded(file: FileHandle): Promise<string | undefined> {
  const buffer = Buffer.alloc(MAX_STARTUP_PROGRESS_BYTES + 1);
  const readAt = async (offset: number): Promise<number> => {
    if (offset >= buffer.length) {
      return offset;
    }
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    return bytesRead === 0 ? offset : readAt(offset + bytesRead);
  };
  const offset = await readAt(0);
  return offset <= MAX_STARTUP_PROGRESS_BYTES
    ? buffer.subarray(0, offset).toString('utf8')
    : undefined;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const ownedPrivate = (uid: number, mode: number) =>
  typeof process.getuid === 'function' && uid === process.getuid() && (mode & 0o077) === 0;
const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
