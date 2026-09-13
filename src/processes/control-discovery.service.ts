import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import type { ControlDiscovery } from './control-discovery.types.js';
import { parseControlRecord } from './control-protocol.js';

export const CONTROL_FILE = '.revo-control.json';
export const MAX_CONTROL_METADATA_BYTES = 16_384;

@Injectable()
export class ControlDiscoveryService {
  async read(dataDir: string): Promise<ControlDiscovery> {
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
        join(canonicalDataDir, CONTROL_FILE),
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
        metadata.size > MAX_CONTROL_METADATA_BYTES
      ) {
        return { kind: 'invalid' };
      }
      const content = await readBounded(file);
      if (!content) {
        return { kind: 'invalid' };
      }
      const record = parseControlRecord(JSON.parse(content));
      return record?.canonicalDataDir === canonicalDataDir
        ? { kind: 'found', record }
        : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    } finally {
      await file.close().catch(() => undefined);
    }
  }
}

async function readBounded(file: FileHandle): Promise<string | undefined> {
  const buffer = Buffer.alloc(MAX_CONTROL_METADATA_BYTES + 1);
  const readAt = async (offset: number): Promise<number> => {
    if (offset >= buffer.length) {
      return offset;
    }
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    return bytesRead === 0 ? offset : readAt(offset + bytesRead);
  };
  const offset = await readAt(0);
  return offset <= MAX_CONTROL_METADATA_BYTES
    ? buffer.subarray(0, offset).toString('utf8')
    : undefined;
}

const ownedPrivate = (uid: number, mode: number) =>
  typeof process.getuid === 'function' && uid === process.getuid() && (mode & 0o077) === 0;
const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
