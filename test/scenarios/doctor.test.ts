import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it, vi } from 'vitest';

import { DoctorCommand } from '../../src/cli/commands/doctor.command.js';
import {
  DoctorComponentProbe,
  type DoctorComponents,
} from '../../src/cli/diagnostics/doctor-component-probe.js';
import {
  DoctorPathProbe,
  type DoctorPathInput,
  type DoctorPaths,
} from '../../src/cli/diagnostics/doctor-path-probe.js';
import { DoctorService } from '../../src/cli/diagnostics/doctor.service.js';
import type { ConfigurationInput } from '../../src/configuration/configuration.types.js';
import type { RevoConfiguration } from '../../src/configuration/configuration.types.js';
import type { ControlServerStatus } from '../../src/processes/control-endpoint.types.js';
import type { ServerStatus } from '../../src/server/server-status.service.js';
import { CliScenario } from '../support/cli/cli-scenario.js';

const configuration = (root: string, databaseUrl?: string): RevoConfiguration => ({
  ...(databaseUrl === undefined ? {} : { databaseUrl }),
  channel: 'stable',
  configPath: join(root, 'config.json'),
  host: '127.0.0.1',
  installDir: join(root, 'install'),
  layout: {
    cacheDir: join(root, 'cache'),
    channel: 'stable',
    configDir: join(root, 'config'),
    dataDir: join(root, 'data'),
    runtimeDir: join(root, 'state', 'run'),
    stateDir: join(root, 'state'),
  },
  logDir: join(root, 'logs'),
  port: 3210,
  publicUrl: 'http://127.0.0.1:3210',
  startupTimeout: 1_000,
});

describe('revo doctor', () => {
  it('is read-only and reports missing fresh paths as stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-doctor-'));
    try {
      const before = await import('node:fs/promises').then(({ readdir }) => readdir(root));
      const paths = await new DoctorPathProbe().inspect({
        data: join(root, 'data'),
        state: join(root, 'state'),
        logs: join(root, 'logs'),
      });
      const after = await import('node:fs/promises').then(({ readdir }) => readdir(root));
      expect(paths).toEqual({ data: 'missing', state: 'missing', logs: 'missing' });
      expect(after).toEqual(before);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('distinguishes private and unsafe existing directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-doctor-'));
    const data = join(root, 'data');
    const state = join(root, 'state');
    const logs = join(root, 'logs');
    try {
      await Promise.all([mkdir(data, { mode: 0o700 }), mkdir(state, { mode: 0o755 }), mkdir(logs)]);
      expect(await new DoctorPathProbe().inspect({ data, state, logs })).toEqual({
        data: 'private',
        state: 'unavailable',
        logs: 'unavailable',
      });
      expect(
        await new DoctorPathProbe().inspect({ data, state: join(root, '\0invalid'), logs }),
      ).toMatchObject({ state: 'unavailable' });
      const file = join(root, 'file');
      await import('node:fs/promises').then(({ writeFile }) => writeFile(file, 'fixture'));
      expect(await new DoctorPathProbe().inspect({ data: file, state, logs })).toMatchObject({
        data: 'unavailable',
      });
      await chmod(logs, 0o700);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('does not load embedded postgres for an external database', async () => {
    let loaded = 0;
    const probe = new DoctorComponentProbe({
      loadCoreRuntime: async () => undefined,
      resolveAdminDirectory: async () => '/admin',
      loadPostgresBinaries: async () => {
        loaded += 1;
        return { initdb: '/initdb', postgres: '/postgres' };
      },
    });
    await expect(
      probe.inspect(configuration('/tmp/doctor', 'postgresql://db/revo')),
    ).resolves.toEqual({
      core: 'available',
      admin: 'available',
      postgres: 'external',
    });
    expect(loaded).toBe(0);
  });

  it('uses the released component probes by default', async () => {
    await expect(new DoctorComponentProbe().inspect(configuration('/tmp/doctor'))).resolves.toEqual(
      {
        core: 'available',
        admin: 'available',
        postgres: 'available',
      },
    );
  }, 20_000);

  it.each([
    { name: 'core', dependencies: { loadCoreRuntime: async () => Promise.reject(new Error()) } },
    {
      name: 'admin',
      dependencies: { resolveAdminDirectory: async () => Promise.reject(new Error()) },
    },
    {
      name: 'postgres binary load',
      dependencies: { loadPostgresBinaries: async () => Promise.reject(new Error()) },
    },
    {
      name: 'postgres executable',
      dependencies: {
        loadPostgresBinaries: async () => ({ initdb: '/initdb', postgres: '/postgres' }),
        executableAvailable: async () => false,
      },
    },
  ])('continues the full report when $name is unavailable', async ({ dependencies }) => {
    const probe = new DoctorComponentProbe({
      loadCoreRuntime: async () => undefined,
      resolveAdminDirectory: async () => '/admin',
      loadPostgresBinaries: async () => ({ initdb: '/initdb', postgres: '/postgres' }),
      executableAvailable: async () => true,
      ...dependencies,
    });
    const report = await probe.inspect(configuration('/tmp/doctor'));
    expect(report).toEqual({
      core: dependencies.loadCoreRuntime === undefined ? 'available' : 'unavailable',
      admin: dependencies.resolveAdminDirectory === undefined ? 'available' : 'unavailable',
      postgres:
        dependencies.loadPostgresBinaries === undefined &&
        dependencies.executableAvailable === undefined
          ? 'available'
          : 'unavailable',
    });
  });

  it.each<ServerStatus['kind']>([
    'running',
    'stopped',
    'starting',
    'stopping',
    'failed',
    'missing',
    'unknown',
  ])('keeps server status kind %s in the typed report', async (kind) => {
    const root = '/tmp/revo-doctor';
    const input: ConfigurationInput = {
      env: {},
      flags: {},
      homeDir: '/tmp/home',
      packageVersion: '9.8.7',
      platform: 'linux',
    };
    const service = doctorService(kind, root);
    const report = await service.inspect(input);
    expect(report).toMatchObject({ channel: 'stable', server: kind, version: '9.8.7' });
  });

  it('marks only running or stopped reports as healthy', async () => {
    const service = doctorService('stopped', '/tmp/revo-doctor');
    const input: ConfigurationInput = {
      env: {},
      flags: {},
      homeDir: '/tmp/home',
      packageVersion: '1.0.0',
      platform: 'linux',
    };
    const healthy = await service.inspect(input);
    expect(service.isHealthy(healthy)).toBe(true);
    for (const server of ['starting', 'stopping', 'failed', 'missing', 'unknown'] as const) {
      expect(service.isHealthy({ ...healthy, server })).toBe(false);
    }
    expect(
      service.isHealthy({ ...healthy, components: { ...healthy.components, core: 'unavailable' } }),
    ).toBe(false);
    expect(
      service.isHealthy({
        ...healthy,
        components: { ...healthy.components, admin: 'unavailable' },
      }),
    ).toBe(false);
    expect(
      service.isHealthy({
        ...healthy,
        components: { ...healthy.components, postgres: 'unavailable' },
      }),
    ).toBe(false);
    expect(
      service.isHealthy({ ...healthy, paths: { ...healthy.paths, data: 'unavailable' } }),
    ).toBe(false);
  });

  it('returns unknown when the existing server status cannot be read', async () => {
    const report = await doctorService('stopped', '/tmp/revo-doctor', true).inspect({
      env: {},
      flags: {},
      homeDir: '/tmp/home',
      packageVersion: '1.0.0',
      platform: 'linux',
    });
    expect(report.server).toBe('unknown');
  });

  it('prints the fixed diagnostic and exits zero for an isolated stopped installation', async () => {
    const result = await CliScenario.runIsolated(['doctor']);
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toMatch(
      /^version: 0\.0\.0\nnode: \S+\nplatform: \S+\nchannel: stable\nconfiguration: valid\ndata: missing\nstate: missing\nlogs: missing\ncore: available\nadmin: available\npostgres: available\nserver: stopped\n$/u,
    );
  });

  it('renders a safe report before returning a failure for an unhealthy report', async () => {
    const report = {
      ...(await doctorService('failed', '/tmp/revo-doctor').inspect({
        env: {},
        flags: {},
        homeDir: '/tmp/home',
        packageVersion: '1.0.0',
        platform: 'linux',
      })),
      server: 'failed' as const,
    };
    const writes: string[] = [];
    const input: ConfigurationInput = {
      env: {},
      flags: {},
      homeDir: '/tmp/home',
      packageVersion: '1.0.0',
      platform: 'linux',
    };
    const doctor = {
      createInput: () => input,
      inspect: async () => report,
      isHealthy: () => false,
    };
    const command = new DoctorCommand(doctor, { write: (value) => writes.push(value) });
    await expect(command.run()).rejects.toThrow('unhealthy installation');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('server: failed');
    await new DoctorCommand(
      { createInput: () => input, inspect: async () => report, isHealthy: () => true },
      { write: () => undefined },
    ).run();
  });

  it('builds input from the ambient runtime without mutating environment state', () => {
    const input = new DoctorService().createInput();
    expect(input.flags).toEqual({});
    expect(input.env).not.toBe(process.env);
  });

  it('maps unsupported runtime input to a safe failure', () => {
    const service = new DoctorService();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(() => service.createInput()).toThrow('unsupported on this platform');
  });
});

function doctorService(
  kind: ServerStatus['kind'],
  root: string,
  statusFailure = false,
): DoctorService {
  const config = configuration(root);
  return new DoctorService(
    {
      resolve: vi
        .fn<(input: Readonly<ConfigurationInput>) => Promise<RevoConfiguration>>()
        .mockResolvedValue(config),
    },
    {
      inspect: vi
        .fn<(paths: DoctorPathInput) => Promise<DoctorPaths>>()
        .mockResolvedValue({ data: 'missing', state: 'missing', logs: 'missing' }),
    },
    {
      inspect: vi
        .fn<(value: Readonly<RevoConfiguration>) => Promise<DoctorComponents>>()
        .mockResolvedValue({ core: 'available', admin: 'available', postgres: 'available' }),
    },
    {
      read: async () => {
        if (statusFailure) {
          throw new Error('status unavailable');
        }
        return statusFor(kind);
      },
    },
    { version: '0.0.0' },
  );
}

function statusFor(kind: ServerStatus['kind']): ServerStatus {
  if (kind === 'missing' || kind === 'unknown' || kind === 'stopped') {
    return { kind };
  }
  const status: ControlServerStatus = { phase: kind };
  return { kind, status };
}
