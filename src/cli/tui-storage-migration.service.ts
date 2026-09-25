import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { Inject, Injectable } from '@nestjs/common';

import { ConfigurationResolver } from '../configuration/configuration-resolver.js';
import type {
  ConfigurationFlags,
  ConfigurationInput,
} from '../configuration/configuration.types.js';
import { CliExitCodeError, CliUsageError } from './cli-error.js';
import { PackageMetadataService } from './package-metadata.service.js';

export const TUI_STORAGE_MIGRATOR = Symbol('TUI_STORAGE_MIGRATOR');

export interface TuiStorageMigrationRequest {
  readonly apiUrl: string;
  readonly dataDir: string;
  readonly confirmedOffline: true;
}

export interface TuiStorageMigrationFlags extends ConfigurationFlags {
  readonly apiUrl?: string;
  readonly confirmOffline?: boolean;
}

export type TuiStorageMigrationLauncher = (request: TuiStorageMigrationRequest) => Promise<number>;

@Injectable()
export class TuiStorageMigrationService {
  constructor(
    @Inject(ConfigurationResolver)
    private readonly configuration: Pick<ConfigurationResolver, 'resolve'>,
    @Inject(PackageMetadataService)
    private readonly metadata: Pick<PackageMetadataService, 'version'>,
    @Inject(TUI_STORAGE_MIGRATOR)
    private readonly migrateStorage: TuiStorageMigrationLauncher,
  ) {}

  async migrate(flags: Readonly<TuiStorageMigrationFlags>): Promise<void> {
    const platform = supportedPlatform();
    if (!flags.apiUrl) {
      throw new CliUsageError('Storage migration requires explicit --api-url.');
    }
    if (flags.confirmOffline !== true) {
      throw new CliUsageError('Storage migration requires --confirm-offline.');
    }

    const { apiUrl, confirmOffline: _confirmOffline, ...configurationFlags } = flags;
    const configuration = await this.configuration.resolve(
      this.input(configurationFlags, platform),
    );
    const exitCode = await this.migrateStorage({
      apiUrl,
      dataDir: join(configuration.layout.dataDir, 'tui'),
      confirmedOffline: true,
    });
    if (exitCode !== 0) {
      throw new CliExitCodeError(exitCode);
    }
  }

  private input(
    flags: Readonly<ConfigurationFlags>,
    platform: 'darwin' | 'linux',
  ): ConfigurationInput {
    return {
      env: { ...process.env },
      flags,
      homeDir: homedir(),
      packageVersion: this.metadata.version,
      platform,
    };
  }
}

export async function launchRevoTuiStorageMigration(
  request: TuiStorageMigrationRequest,
): Promise<number> {
  const tuiLauncher = await import('@revisium/revo-tui/launcher');
  if (!isMigrationCapableLauncher(tuiLauncher)) {
    throw new Error(
      'The installed revo-tui package does not support command-storage migration; update Revo to a release containing the migration-capable TUI.',
    );
  }
  return tuiLauncher.runStorageMigration(request);
}

function supportedPlatform(): 'darwin' | 'linux' {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return process.platform;
  }
  throw new CliUsageError('TUI storage migration is supported only on Linux and macOS.');
}

function isMigrationCapableLauncher(
  value: unknown,
): value is { readonly runStorageMigration: TuiStorageMigrationLauncher } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'runStorageMigration') === 'function'
  );
}
