// oxlint-disable-next-line import/no-unassigned-import -- decorators require this side effect first
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { CommandFactory } from 'nest-commander';
import { describe, expect, it, vi } from 'vitest';

import { CliExitCodeError, CliUsageError, cliFailure } from '../../src/cli/cli-error.js';
import { TuiStorageMigrateCommand } from '../../src/cli/commands/tui-storage-migrate.command.js';
import { TuiStorageCommand } from '../../src/cli/commands/tui-storage.command.js';
import { TuiCommand } from '../../src/cli/commands/tui.command.js';
import { PackageMetadataService } from '../../src/cli/package-metadata.service.js';
import { TuiCommandService } from '../../src/cli/tui-command.service.js';
import {
  TUI_STORAGE_MIGRATOR,
  TuiStorageMigrationService,
  type TuiStorageMigrationFlags,
  type TuiStorageMigrationLauncher,
} from '../../src/cli/tui-storage-migration.service.js';
import { ConfigurationResolver } from '../../src/configuration/configuration-resolver.js';
import type { RevoConfiguration } from '../../src/configuration/configuration.types.js';
import { resolveRevoLayout } from '../../src/layout.js';

const RESOLVED_CONFIGURATION: Readonly<RevoConfiguration> = {
  channel: 'stable',
  configPath: '/fixture/config.json',
  host: '127.0.0.1',
  installDir: '/fixture/install',
  layout: {
    ...resolveRevoLayout({ channel: 'stable', env: {}, homeDir: '/fixture', platform: 'linux' }),
    dataDir: '/fixture/revo-data',
  },
  logDir: '/fixture/logs',
  port: 3210,
  publicUrl: 'http://127.0.0.1:3210',
  startupTimeout: 180_000,
};

async function invokeCommand(args: readonly string[]) {
  const resolve = vi.fn<ConfigurationResolver['resolve']>(async (_input) => RESOLVED_CONFIGURATION);
  const migrateStorage = vi.fn<TuiStorageMigrationLauncher>(async () => 0);
  @Module({
    providers: [
      TuiCommand,
      TuiStorageCommand,
      TuiStorageMigrateCommand,
      TuiStorageMigrationService,
      { provide: TuiCommandService, useValue: {} },
      { provide: ConfigurationResolver, useValue: { resolve } },
      { provide: PackageMetadataService, useValue: { cliName: 'revo', version: '0.0.0' } },
      { provide: TUI_STORAGE_MIGRATOR, useValue: migrateStorage },
    ],
  })
  // oxlint-disable-next-line typescript/no-extraneous-class -- Nest test module metadata
  class TestModule {}

  const originalArgv = process.argv;
  const stdout: string[] = [];
  const stderr: string[] = [];
  process.argv = ['node', 'revo', ...args];
  let exitCode = 0;
  try {
    await CommandFactory.run(TestModule, {
      cliName: 'revo',
      errorHandler: rethrow,
      logger: false,
      outputConfiguration: {
        writeErr: (text) => stderr.push(text),
        writeOut: (text) => stdout.push(text),
      },
      serviceErrorHandler: rethrow,
    });
  } catch (error) {
    const failure = cliFailure(error);
    exitCode = failure.exitCode;
    if (failure.message !== undefined) {
      stderr.push(`${failure.message}\n`);
    }
  } finally {
    process.argv = originalArgv;
  }
  return { exitCode, migrateStorage, resolve, stderr: stderr.join(''), stdout: stdout.join('') };
}

const rethrow = (error: Error): never => {
  throw error;
};

function createService(launch: TuiStorageMigrationLauncher = async () => 0) {
  const resolve = vi.fn<ConfigurationResolver['resolve']>(async (_input) => RESOLVED_CONFIGURATION);
  const migrateStorage = vi.fn<TuiStorageMigrationLauncher>(launch);
  const service = new TuiStorageMigrationService({ resolve }, { version: '0.0.0' }, migrateStorage);
  return { migrateStorage, resolve, service };
}

describe('revo tui storage migrate', () => {
  it.each([
    { args: ['tui', '--data-dir', '/fixture/custom-data', 'storage', 'migrate'] },
    { args: ['tui', 'storage', '--data-dir', '/fixture/custom-data', 'migrate'] },
    { args: ['tui', 'storage', 'migrate', '--data-dir', '/fixture/custom-data'] },
  ])('inherits the Revo data directory from the tui command: $args', async ({ args }) => {
    const result = await invokeCommand([
      ...args,
      '--api-url',
      'http://127.0.0.1:3210/graphql',
      '--confirm-offline',
    ]);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.resolve.mock.calls[0]?.[0].flags).toEqual({
      dataDir: '/fixture/custom-data',
    });
    expect(result.migrateStorage).toHaveBeenCalledExactlyOnceWith({
      apiUrl: 'http://127.0.0.1:3210/graphql',
      dataDir: '/fixture/revo-data/tui',
      confirmedOffline: true,
    });
  });

  it('rejects repeated configuration flags and server-only startup options', async () => {
    const repeated = await invokeCommand([
      'tui',
      '--data-dir',
      '/fixture/one',
      'storage',
      'migrate',
      '--data-dir',
      '/fixture/two',
      '--api-url',
      'http://127.0.0.1/graphql',
      '--confirm-offline',
    ]);
    const timeout = await invokeCommand([
      'tui',
      '--startup-timeout',
      '1000',
      'storage',
      'migrate',
      '--api-url',
      'http://127.0.0.1/graphql',
      '--confirm-offline',
    ]);

    expect(repeated.exitCode).toBe(2);
    expect(timeout.exitCode).toBe(2);
    expect(repeated.migrateStorage).not.toHaveBeenCalled();
    expect(timeout.migrateStorage).not.toHaveBeenCalled();
  });

  it('resolves the configured Revo data directory without starting the server', async () => {
    const { migrateStorage, resolve, service } = createService();
    const flags: TuiStorageMigrationFlags = {
      apiUrl: 'http://127.0.0.1:3210/graphql',
      channel: 'stable',
      confirmOffline: true,
      dataDir: '/fixture/custom-data',
    };

    await service.migrate(flags);

    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0]?.[0].flags).toEqual({
      channel: 'stable',
      dataDir: '/fixture/custom-data',
    });
    expect(migrateStorage).toHaveBeenCalledExactlyOnceWith({
      apiUrl: 'http://127.0.0.1:3210/graphql',
      dataDir: '/fixture/revo-data/tui',
      confirmedOffline: true,
    });
  });

  it('requires the old GraphQL URL and offline acknowledgement before resolving configuration', async () => {
    const { migrateStorage, resolve, service } = createService();

    await expect(service.migrate({ confirmOffline: true })).rejects.toBeInstanceOf(CliUsageError);
    await expect(service.migrate({ apiUrl: 'http://127.0.0.1/graphql' })).rejects.toBeInstanceOf(
      CliUsageError,
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(migrateStorage).not.toHaveBeenCalled();
  });

  it('propagates migration failure exit codes without masking them as server failures', async () => {
    const { service } = createService(async () => 7);
    const error = await service
      .migrate({
        apiUrl: 'http://127.0.0.1:3210/graphql',
        confirmOffline: true,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CliExitCodeError);
    expect(cliFailure(error)).toEqual({ exitCode: 7 });
  });
});
