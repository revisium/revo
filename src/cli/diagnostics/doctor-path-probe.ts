import { lstat } from 'node:fs/promises';

import { Injectable } from '@nestjs/common';

export type DoctorPathStatus = 'missing' | 'private' | 'unavailable';

export interface DoctorPaths {
  readonly data: DoctorPathStatus;
  readonly state: DoctorPathStatus;
  readonly logs: DoctorPathStatus;
}

export interface DoctorPathInput {
  readonly data: string;
  readonly state: string;
  readonly logs: string;
}

/** Read-only checks for product directories. This probe never creates or changes paths. */
@Injectable()
export class DoctorPathProbe {
  async inspect(paths: DoctorPathInput): Promise<DoctorPaths> {
    const [data, state, logs] = await Promise.all([
      this.inspectPath(paths.data),
      this.inspectPath(paths.state),
      this.inspectPath(paths.logs),
    ]);
    return { data, state, logs };
  }

  private async inspectPath(directory: string): Promise<DoctorPathStatus> {
    try {
      const entry = await lstat(directory);
      if (!entry.isDirectory()) {
        return 'unavailable';
      }
      return (entry.mode & 0o077) === 0 ? 'private' : 'unavailable';
    } catch (error: unknown) {
      return this.isMissing(error) ? 'missing' : 'unavailable';
    }
  }

  private isMissing(error: unknown): boolean {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
  }
}
