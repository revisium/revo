import { constants, type Stats } from 'node:fs';
import { type FileHandle, lstat, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import { EmbeddedPostgresError } from './embedded-postgres.types.js';

const DIAGNOSTIC_BYTES = 16 * 1024;

export interface PostgresLogOutput {
  readonly descriptor: number;
  readonly offset: number;
}

export class EmbeddedPostgresLog {
  constructor(readonly path: string) {}

  append<T>(spawn: (output: PostgresLogOutput) => Promise<T>): Promise<T> {
    return this.withPrivateFile((file, size) => spawn({ descriptor: file.fd, offset: size }));
  }

  async record(detail: string): Promise<void> {
    try {
      await this.withPrivateFile((file) => file.write(`revo: ${detail}\n`));
    } catch {
      // The refusal stays the primary failure even when its log cannot be written.
    }
  }

  async readFrom(offset: number): Promise<string> {
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(DIAGNOSTIC_BYTES);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
  }

  private async withPrivateFile<T>(
    use: (file: FileHandle, size: number) => Promise<T>,
  ): Promise<T> {
    await this.preparePrivateDirectory();
    const file = await open(
      this.path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    ).catch(() => {
      throw this.unsafe();
    });
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || !privateOwned(metadata)) {
        throw this.unsafe();
      }
      return await use(file, metadata.size);
    } finally {
      await file.close();
    }
  }

  private async preparePrivateDirectory() {
    const directory = dirname(this.path);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const metadata = await lstat(directory);
      if (metadata.isDirectory() && privateOwned(metadata)) {
        return;
      }
    } catch {
      throw this.unsafe();
    }
    throw this.unsafe();
  }

  private unsafe() {
    return new EmbeddedPostgresError('invalid', false, undefined, {
      detail: `the PostgreSQL log ${this.path} is not a private file of the current user`,
    });
  }
}

const privateOwned = (metadata: Stats) =>
  metadata.uid === process.getuid?.() && (metadata.mode & 0o077) === 0;
