import { describe, expect, it } from 'vitest';

import { MAX_STARTUP_TIMEOUT_MILLISECONDS } from '../../src/configuration/configuration.types.js';
import { ConfigurationError } from '../../src/configuration/index.js';
import {
  ConfigurationScenario,
  configFile,
} from '../support/configuration/configuration-scenario.js';

describe('configuration resolution', () => {
  it('resolves stable defaults with separate installation and channel paths', async () => {
    const result = await ConfigurationScenario.defaults().resolve();

    expect(result).toMatchObject({
      channel: 'stable',
      host: '127.0.0.1',
      port: 3210,
      publicUrl: 'http://127.0.0.1:3210',
      startupTimeout: 180_000,
    });
    expect(result.logDir).toBe(`${result.layout.stateDir}/logs`);
    expect(result.installDir).toMatch(/\/\.local\/share\/revo-install\/stable$/u);
    expect(result.installDir).not.toBe(result.layout.dataDir);
  });

  it.each([
    { version: '1.0.0-alpha.1', env: {}, flags: {}, expected: 'alpha' },
    { version: '1.0.0-alpha.1', env: { REVO_CHANNEL: 'stable' }, flags: {}, expected: 'stable' },
    {
      version: '1.0.0',
      env: { REVO_CHANNEL: 'stable' },
      flags: { channel: 'alpha' },
      expected: 'alpha',
    },
  ])('selects $expected channel by precedence', async ({ version, env, flags, expected }) => {
    const result = await ConfigurationScenario.defaults()
      .withPackageVersion(version)
      .withEnv(env)
      .withFlags(flags)
      .resolve();
    expect(result.channel).toBe(expected);
    expect(result.port).toBe(expected === 'alpha' ? 3211 : 3210);
  });

  it('rejects a stable selection from the alpha wrapper', async () => {
    await expect(
      ConfigurationScenario.defaults()
        .withWrapper('alpha')
        .withFlags({ channel: 'stable' })
        .resolve(),
    ).rejects.toMatchObject({ code: 'revo.configuration.invalid', field: 'channel', exitCode: 2 });
  });

  it('pins the alpha wrapper when package metadata has no prerelease', async () => {
    const result = await ConfigurationScenario.defaults().withWrapper('alpha').resolve();

    expect(result.channel).toBe('alpha');
  });

  it('applies flags over environment and file without validating a shadowed environment value', async () => {
    const result = await ConfigurationScenario.defaults()
      .withFile(configFile({ host: 'file.example', port: 4000 }))
      .withEnv({ REVO_HOST: 'env.example', REVO_PORT: 'not-a-port' })
      .withFlags({ host: 'flag.example', port: 5000 })
      .resolve();
    expect(result).toMatchObject({ host: 'flag.example', port: 5000 });
  });

  it('applies environment over the configuration file', async () => {
    const result = await ConfigurationScenario.defaults()
      .withFile(configFile({ host: 'file.example', port: 4000 }))
      .withEnv({ REVO_HOST: 'env.example', REVO_PORT: '5000', DATABASE_URL: 'ignored' })
      .resolve();
    expect(result).toMatchObject({ host: 'env.example', port: 5000 });
    expect(result.databaseUrl).toBeUndefined();
  });

  it.each(['linux', 'darwin'] as const)(
    'preserves paths with spaces on $platform',
    async (platform) => {
      const result = await ConfigurationScenario.defaults()
        .withPlatform(platform)
        .withFile(configFile({ dataDir: '/data/revo files', logDir: '/logs/revo files' }))
        .resolve();
      expect(result.layout.dataDir).toBe('/data/revo files');
      expect(result.logDir).toBe('/logs/revo files');
    },
  );

  it('keeps non-overridden layout directories channel scoped', async () => {
    const result = await ConfigurationScenario.defaults()
      .withEnv({ XDG_STATE_HOME: '/state', XDG_CACHE_HOME: '/cache', REVO_DATA_DIR: '/custom' })
      .withFlags({ channel: 'alpha' })
      .resolve();
    expect(result.layout).toMatchObject({
      dataDir: '/custom',
      stateDir: '/state/revo-alpha',
      cacheDir: '/cache/revo-alpha',
    });
    expect(result.layout.runtimeDir).toBe('/state/revo-alpha/run');
  });

  it('derives the default configuration path from XDG_CONFIG_HOME', async () => {
    const result = await ConfigurationScenario.defaults()
      .withEnv({ XDG_CONFIG_HOME: '/configuration root' })
      .resolve();

    expect(result.configPath).toBe('/configuration root/revo/config.json');
  });

  it('reports invalid layout environment paths as configuration input errors', async () => {
    await expect(
      ConfigurationScenario.defaults().withEnv({ XDG_CONFIG_HOME: 'relative' }).resolve(),
    ).rejects.toMatchObject({
      code: 'revo.configuration.invalid',
      exitCode: 2,
      field: 'XDG_CONFIG_HOME',
      source: 'environment',
    });
  });

  it('normalizes IPv6 listen and public URL representations', async () => {
    const result = await ConfigurationScenario.defaults()
      .withFlags({ host: '[::1]', publicUrl: 'https://[::1]:4443/' })
      .resolve();
    expect(result.host).toBe('::1');
    expect(result.publicUrl).toBe('https://[::1]:4443');
  });

  it('loads an actual selected configuration file', async () => {
    const result = await ConfigurationScenario.defaults()
      .withFile(
        configFile({ databaseUrl: 'postgresql://user:secret@db/revo', startupTimeout: 9000 }),
      )
      .resolve();
    expect(result.databaseUrl).toBe('postgresql://user:secret@db/revo');
    expect(result.startupTimeout).toBe(9000);
  });

  it('selects a configuration file from the environment', async () => {
    const result = await ConfigurationScenario.defaults()
      .withEnvironmentFile(configFile({ host: 'environment-file.example' }))
      .resolve();

    expect(result.host).toBe('environment-file.example');
  });

  it('allows an absent default file but rejects an absent explicit file', async () => {
    await expect(ConfigurationScenario.defaults().resolve()).resolves.toBeDefined();
    await expect(
      ConfigurationScenario.defaults().withMissingExplicitFile().resolve(),
    ).rejects.toMatchObject({
      code: 'revo.configuration.file',
      exitCode: 1,
      field: 'config',
      source: 'config-file',
    });
  });

  it.each([
    ['malformed JSON', '{'],
    ['wrong schema', { schemaVersion: 2 }],
    ['unknown field', { schemaVersion: 1, channel: 'alpha' }],
    ['wrong type', { schemaVersion: 1, port: '3210' }],
  ])('rejects an invalid file: %s', async (_case, file) => {
    await expect(ConfigurationScenario.defaults().withFile(file).resolve()).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it('does not retain malformed JSON containing a secret in the error graph', async () => {
    const error = await ConfigurationScenario.defaults()
      .withFile('{"password":"do-not-retain"')
      .resolve()
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'revo.configuration.invalid', cause: undefined });
    expect(String(error)).not.toContain('do-not-retain');
  });

  it.each([
    ['port', { port: 0 }],
    ['port', { port: 65_536 }],
    ['startupTimeout', { startupTimeout: 0 }],
    ['host', { host: 'bad host' }],
    ['host', { host: '[not-ipv6]' }],
    ['dataDir', { dataDir: 'relative/path' }],
    ['dataDir', { dataDir: '/tmp/revo\0data' }],
    ['logDir', { logDir: '' }],
    ['config', { config: '/tmp/revo\0config' }],
    ['publicUrl', { publicUrl: 'https://example.com/api' }],
    ['publicUrl', { publicUrl: 'https://user:secret@example.com' }],
    ['databaseUrl', { databaseUrl: 'https://example.com/db' }],
  ])('rejects invalid selected $field without exposing its value', async (field, flags) => {
    const secret = Object.values(flags)[0];
    const sensitiveValue =
      typeof secret === 'string' && secret.length > 3 ? secret : '__not-input__';
    const error = await ConfigurationScenario.defaults()
      .withFlags(flags)
      .resolve()
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'revo.configuration.invalid', exitCode: 2, field });
    expect(error).not.toHaveProperty('message', expect.stringContaining(sensitiveValue));
  });

  it('accepts the maximum launchable startupTimeout', async () => {
    const result = await ConfigurationScenario.defaults()
      .withFlags({ startupTimeout: MAX_STARTUP_TIMEOUT_MILLISECONDS })
      .resolve();

    expect(result.startupTimeout).toBe(MAX_STARTUP_TIMEOUT_MILLISECONDS);
  });

  it('rejects a startupTimeout beyond the maximum launchable value', async () => {
    await expect(
      ConfigurationScenario.defaults()
        .withFlags({ startupTimeout: MAX_STARTUP_TIMEOUT_MILLISECONDS + 1 })
        .resolve(),
    ).rejects.toMatchObject({
      code: 'revo.configuration.invalid',
      exitCode: 2,
      field: 'startupTimeout',
      source: 'flags',
    });
  });

  it('attributes selected environment validation without exposing a database secret', async () => {
    const error = await ConfigurationScenario.defaults()
      .withEnv({ REVO_DATABASE_URL: 'https://user:do-not-print@example.com/db' })
      .resolve()
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ field: 'databaseUrl', source: 'environment', exitCode: 2 });
    expect(error).not.toHaveProperty('message', expect.stringContaining('do-not-print'));
  });

  it('does not mutate inputs and freezes the result graph', async () => {
    expect(
      await ConfigurationScenario.defaults().withEnv({ REVO_PORT: '4000' }).preservesInputs(),
    ).toBe(true);
    const result = await ConfigurationScenario.defaults().resolve();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.layout)).toBe(true);
  });
});
