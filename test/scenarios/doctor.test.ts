import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DoctorComponentProbe } from '../../src/cli/diagnostics/doctor-component-probe.js';
import { DoctorPathProbe } from '../../src/cli/diagnostics/doctor-path-probe.js';
import type { RevoConfiguration } from '../../src/configuration/configuration.types.js';
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

  it('prints the fixed diagnostic and exits zero for an isolated stopped installation', async () => {
    const result = await CliScenario.runIsolated(['doctor']);
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toMatch(
      /^version: 0\.0\.0\nnode: \S+\nplatform: \S+\nchannel: stable\nconfiguration: valid\ndata: missing\nstate: missing\nlogs: missing\ncore: available\nadmin: available\npostgres: available\nserver: stopped\n$/u,
    );
  });
});
