import type { Stats } from 'node:fs';
import { mkdir, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { PosixFlockAdapter, type NativeLock } from './adapters/posix-flock.adapter.js';
import type { HeldServerOwnership, ServerOwnership } from './ownership.types.js';

const PRIVATE_PERMISSIONS = 0o077;

@Injectable()
export class ServerOwnershipService {
  constructor(
    @Inject(PosixFlockAdapter)
    private readonly flock: PosixFlockAdapter = new PosixFlockAdapter(),
  ) {}

  async acquire(dataDir: string): Promise<ServerOwnership> {
    const canonicalDataDir = await this.prepareDataDirectory(dataDir);
    const lockPath = path.join(canonicalDataDir, '.revo-server.lock');
    const file = await open(lockPath, this.flock.openFlags(process.platform), 0o600);
    let nativeLock: NativeLock | undefined;
    try {
      await this.validateOwnedPrivateFile(file, lockPath);
      nativeLock = await this.flock.lock(file);
    } catch (error) {
      await this.closeAfterFailure(file);
      throw error;
    }
    if (nativeLock === undefined) {
      await file.close();
      return { kind: 'busy' };
    }

    return this.lease(file, nativeLock, lockPath);
  }

  private async prepareDataDirectory(dataDir: string): Promise<string> {
    await mkdir(dataDir, { mode: 0o700, recursive: true });
    const canonical = await realpath(dataDir);
    const metadata = await stat(canonical);
    this.validateOwnerAndMode(metadata, canonical, true);
    return canonical;
  }

  private async validateOwnedPrivateFile(file: FileHandle, lockPath: string): Promise<void> {
    const metadata = await file.stat();
    this.validateOwnerAndMode(metadata, lockPath, false);
  }

  private validateOwnerAndMode(metadata: Stats, location: string, directory: boolean): void {
    const expectedType = directory ? metadata.isDirectory() : metadata.isFile();
    if (!expectedType) {
      throw new Error(`Server ownership path has an invalid type: ${location}`);
    }
    if (typeof process.getuid !== 'function' || metadata.uid !== process.getuid()) {
      throw new Error(`Server ownership path is not owned by the current user: ${location}`);
    }
    if ((metadata.mode & PRIVATE_PERMISSIONS) !== 0) {
      throw new Error(`Server ownership path permissions are not private: ${location}`);
    }
  }

  private lease(file: FileHandle, nativeLock: NativeLock, lockPath: string): HeldServerOwnership {
    let released = false;
    return Object.freeze({
      kind: 'held' as const,
      lockPath,
      release: async (): Promise<void> => {
        if (released) {
          return;
        }
        released = true;
        let failure: unknown;
        try {
          nativeLock.unlock();
        } catch (error) {
          failure = error;
        }
        try {
          await file.close();
        } catch (error) {
          failure ??= error;
        }
        if (failure !== undefined) {
          throw failure;
        }
      },
    });
  }

  private async closeAfterFailure(file: FileHandle): Promise<void> {
    try {
      await file.close();
    } catch (closeFailure) {
      throw new Error('Server ownership descriptor could not be closed after a failure.', {
        cause: closeFailure,
      });
    }
  }
}
