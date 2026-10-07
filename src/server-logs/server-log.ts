import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { errorCode } from '../errors.js';
import { ownedPrivate, READ_NOFOLLOW_FLAGS } from '../private-files.js';
import type { ServerLifecycleConfiguration } from './server-lifecycle.types.js';
import { ensurePrivateLogDirectory, serverLogDirectory } from './store.service.js';

const SERVER_LOG_FILE = 'server.log';
export const SERVER_LOG_TAIL_LINES = 40;

const ATTEMPT_MARKER = '--- Revo server start';
const TAIL_BYTES = 64 * 1024;
const APPEND_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

export interface ServerLogLocation {
  readonly logDir: string;
  readonly channel: ServerLifecycleConfiguration['channel'];
  readonly dataDir: string;
}

export interface OpenedServerLog {
  readonly path: string;
  readonly handle: FileHandle;
}

interface ServerLogTail {
  readonly path: string;
  readonly lines: readonly string[];
}

export class ServerLogError extends Error {
  readonly code = 'SERVER_LOG_UNAVAILABLE';

  constructor(readonly path: string) {
    super(`Server log is unavailable: ${path}`);
    this.name = 'ServerLogError';
  }
}

export async function serverLogPath(location: ServerLogLocation): Promise<string> {
  return join(serverLogDirectory(await lifecycleConfiguration(location)), SERVER_LOG_FILE);
}

export async function openServerLog(
  location: ServerLogLocation,
  now: () => number = Date.now,
): Promise<OpenedServerLog> {
  const configuration = await lifecycleConfiguration(location);
  const path = join(serverLogDirectory(configuration), SERVER_LOG_FILE);
  let handle: FileHandle | undefined;
  try {
    await ensurePrivateLogDirectory(configuration);
    handle = await open(path, APPEND_FLAGS, 0o600);
    await requirePrivateFile(handle);
    await handle.write(`${ATTEMPT_MARKER} ${new Date(now()).toISOString()} ---\n`);
    return { path, handle };
  } catch {
    await handle?.close().catch(() => undefined);
    throw new ServerLogError(path);
  }
}

/** With `since`, only a start attempt recorded at or after that time counts as this start's log. */
export async function readServerLogTail(
  location: ServerLogLocation,
  maxLines = SERVER_LOG_TAIL_LINES,
  since?: number,
): Promise<ServerLogTail | undefined> {
  let path: string;
  let handle: FileHandle;
  try {
    path = await serverLogPath(location);
    handle = await open(path, READ_NOFOLLOW_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const size = await requirePrivateFile(handle);
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) {
      lines.shift();
    }
    const attempt = latestAttempt(lines);
    const marked = attempt[0]?.startsWith(ATTEMPT_MARKER) === true;
    // Without a marker in the window, the last write time tells whether this start wrote to the log.
    const started = marked ? attemptTime(attempt[0]) : (await handle.stat()).mtimeMs;
    if (since !== undefined && (Number.isNaN(started) || started < since)) {
      return undefined;
    }
    return { path, lines: attempt.slice(-maxLines).map(printable) };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function lifecycleConfiguration(
  location: ServerLogLocation,
): Promise<ServerLifecycleConfiguration> {
  return {
    logDir: location.logDir,
    channel: location.channel,
    canonicalDataDir: await canonicalPath(location.dataDir),
  };
}

/** Canonicalizes the existing ancestor so a data directory created later maps to the same log. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if (errorCode(error) !== 'ENOENT' || parent === path) {
      return path;
    }
    return join(await canonicalPath(parent), basename(path));
  }
}

async function requirePrivateFile(handle: FileHandle): Promise<number> {
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.nlink !== 1 || !ownedPrivate(metadata)) {
    throw new Error('Server log is not a private file');
  }
  return metadata.size;
}

function latestAttempt(lines: readonly string[]): readonly string[] {
  const complete = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
  const start = complete.findLastIndex((line) => line.startsWith(ATTEMPT_MARKER));
  return start < 0 ? complete : complete.slice(start);
}

function attemptTime(marker: string | undefined): number {
  if (marker?.startsWith(ATTEMPT_MARKER) !== true) {
    return Number.NaN;
  }
  const [stamp = ''] = marker.slice(ATTEMPT_MARKER.length).trim().split(' ');
  return Date.parse(stamp);
}

/** Log lines reach a terminal; control characters must not become terminal commands. */
function printable(line: string): string {
  return Array.from(line, (character) => (controlCharacter(character) ? '?' : character)).join('');
}

function controlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (code < 0x20 && code !== 0x09) || (code >= 0x7f && code <= 0x9f);
}
