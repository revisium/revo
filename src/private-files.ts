import { constants, type Stats } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { errorCode } from './errors.js';

export const READ_NOFOLLOW_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export const ownedPrivate = (metadata: Pick<Stats, 'uid' | 'mode'>): boolean =>
  typeof process.getuid === 'function' &&
  metadata.uid === process.getuid() &&
  (metadata.mode & 0o077) === 0;

/** A regular file that the descriptor and the path name alike, with no other hard link. */
export const isSingleLinkedPrivateFile = (descriptor: Stats, pathname: Stats): boolean =>
  descriptor.isFile() &&
  pathname.isFile() &&
  ownedPrivate(descriptor) &&
  descriptor.nlink === 1 &&
  pathname.nlink === 1 &&
  descriptor.dev === pathname.dev &&
  descriptor.ino === pathname.ino;

/** Returns undefined when the file holds more than `maxBytes`. */
export async function readBoundedUtf8(
  file: FileHandle,
  maxBytes: number,
): Promise<string | undefined> {
  const buffer = Buffer.alloc(maxBytes + 1);
  const readAt = async (offset: number): Promise<number> => {
    if (offset >= buffer.length) {
      return offset;
    }
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    return bytesRead === 0 ? offset : readAt(offset + bytesRead);
  };
  const length = await readAt(0);
  return length <= maxBytes ? buffer.subarray(0, length).toString('utf8') : undefined;
}

export type PrivateDataFile =
  | { readonly kind: 'missing' | 'unavailable' | 'invalid' }
  | { readonly kind: 'read'; readonly canonicalDataDir: string; readonly content: string };

/** Reads a private file directly inside a private data directory; empty content is invalid. */
export async function readPrivateDataFile(
  dataDir: string,
  name: string,
  maxBytes: number,
): Promise<PrivateDataFile> {
  let canonicalDataDir: string;
  try {
    canonicalDataDir = await realpath(dataDir);
    const directory = await stat(canonicalDataDir);
    if (!directory.isDirectory() || !ownedPrivate(directory)) {
      return { kind: 'unavailable' };
    }
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unavailable' };
  }
  let file: FileHandle;
  try {
    file = await open(join(canonicalDataDir, name), READ_NOFOLLOW_FLAGS);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unavailable' };
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || !ownedPrivate(metadata) || metadata.size > maxBytes) {
      return { kind: 'invalid' };
    }
    const content = await readBoundedUtf8(file, maxBytes);
    return content ? { kind: 'read', canonicalDataDir, content } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  } finally {
    await file.close().catch(() => undefined);
  }
}
