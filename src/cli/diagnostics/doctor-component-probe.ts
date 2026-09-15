import { access, constants } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Injectable, Optional } from '@nestjs/common';

import { resolveAdminClientDirectory } from '../../admin/admin-spa.js';
import type { RevoConfiguration } from '../../configuration/configuration.types.js';
import { loadEmbeddedPostgresBinaries } from '../../postgres/embedded-postgres-binaries.js';

export type DoctorAvailability = 'available' | 'unavailable';
export type DoctorPostgresAvailability = DoctorAvailability | 'external';

export interface DoctorComponents {
  readonly core: DoctorAvailability;
  readonly admin: DoctorAvailability;
  readonly postgres: DoctorPostgresAvailability;
}

export interface DoctorComponentProbeDependencies {
  readonly loadCoreRuntime?: () => Promise<unknown>;
  readonly resolveAdminDirectory?: () => Promise<string>;
  readonly loadPostgresBinaries?: () => Promise<Readonly<{ initdb: string; postgres: string }>>;
  readonly executableAvailable?: (path: string) => Promise<boolean>;
}

/** Checks released public component entrypoints without starting any component. */
@Injectable()
export class DoctorComponentProbe {
  private readonly loadCoreRuntime: () => Promise<unknown>;
  private readonly resolveAdminDirectory: () => Promise<string>;
  private readonly loadPostgresBinaries: () => Promise<
    Readonly<{ initdb: string; postgres: string }>
  >;
  private readonly executableAvailable: (path: string) => Promise<boolean>;

  constructor(@Optional() dependencies: DoctorComponentProbeDependencies = {}) {
    this.loadCoreRuntime = dependencies.loadCoreRuntime ?? loadCoreRuntime;
    this.resolveAdminDirectory = dependencies.resolveAdminDirectory ?? resolveAdminClientDirectory;
    this.loadPostgresBinaries = dependencies.loadPostgresBinaries ?? loadEmbeddedPostgresBinaries;
    this.executableAvailable = dependencies.executableAvailable ?? executable;
  }

  async inspect(configuration: Readonly<RevoConfiguration>): Promise<DoctorComponents> {
    const [core, admin, postgres] = await Promise.all([
      this.probeCore(),
      this.probeAdmin(),
      this.probePostgres(configuration),
    ]);
    return { core, admin, postgres };
  }

  private async probeCore(): Promise<DoctorAvailability> {
    try {
      await this.loadCoreRuntime();
      return 'available';
    } catch {
      return 'unavailable';
    }
  }

  private async probeAdmin(): Promise<DoctorAvailability> {
    try {
      await this.resolveAdminDirectory();
      return 'available';
    } catch {
      return 'unavailable';
    }
  }

  private async probePostgres(
    configuration: Readonly<RevoConfiguration>,
  ): Promise<DoctorPostgresAvailability> {
    if (configuration.databaseUrl !== undefined) {
      return 'external';
    }
    try {
      const binaries = await this.loadPostgresBinaries();
      const [initdb, postgres] = await Promise.all([
        this.executableAvailable(binaries.initdb),
        this.executableAvailable(binaries.postgres),
      ]);
      return initdb && postgres ? 'available' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }
}

async function loadCoreRuntime(): Promise<unknown> {
  const entrypoint = import.meta.resolve('@revisium/revo-core/runtime');
  await access(fileURLToPath(entrypoint), constants.F_OK);
  return undefined;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
