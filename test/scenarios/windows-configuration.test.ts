import { describe, expect, it } from 'vitest';

import {
  WindowsConfigurationScenario,
  type WindowsConfigurationScenarioOptions,
} from '../support/configuration/windows-configuration-scenario.js';

const HOME = 'C:\\Users\\Revo User';
const APPDATA = `${HOME}\\AppData\\Roaming`;
const LOCALAPPDATA = `${HOME}\\AppData\\Local`;
const STABLE_CONFIG = `${APPDATA}\\Revisium\\Revo\\config\\config.json`;

function scenario(
  expectedConfigPath: string,
  options: Omit<WindowsConfigurationScenarioOptions, 'expectedConfigPath'> = {},
): WindowsConfigurationScenario {
  return new WindowsConfigurationScenario({ expectedConfigPath, ...options });
}

describe('Windows configuration resolution', () => {
  it('resolves stable defaults with isolated per-user Windows paths', async () => {
    const subject = scenario(STABLE_CONFIG);
    const result = await subject.resolve();

    expect(result).toMatchObject({
      channel: 'stable',
      configPath: STABLE_CONFIG,
      host: '127.0.0.1',
      installDir: `${LOCALAPPDATA}\\Revisium\\revo-install\\stable`,
      logDir: `${LOCALAPPDATA}\\Revisium\\Revo\\state\\logs`,
      port: 3210,
      publicUrl: 'http://127.0.0.1:3210',
      startupTimeout: 180_000,
      layout: {
        cacheDir: `${LOCALAPPDATA}\\Revisium\\Revo\\cache`,
        configDir: `${APPDATA}\\Revisium\\Revo\\config`,
        dataDir: `${LOCALAPPDATA}\\Revisium\\Revo\\data`,
        runtimeDir: `${LOCALAPPDATA}\\Revisium\\Revo\\state\\run`,
        stateDir: `${LOCALAPPDATA}\\Revisium\\Revo\\state`,
      },
    });
    expect(subject.reads).toEqual([{ logicalPath: STABLE_CONFIG, explicit: false }]);
  });

  it('keeps alpha defaults isolated from stable on Windows', async () => {
    const alphaConfig = `${APPDATA}\\Revisium\\Revo Alpha\\config\\config.json`;
    const result = await scenario(alphaConfig, { packageVersion: '1.0.0-alpha.1' }).resolve();

    expect(result).toMatchObject({
      channel: 'alpha',
      configPath: alphaConfig,
      installDir: `${LOCALAPPDATA}\\Revisium\\revo-install\\alpha`,
      logDir: `${LOCALAPPDATA}\\Revisium\\Revo Alpha\\state\\logs`,
      port: 3211,
      publicUrl: 'http://127.0.0.1:3211',
      layout: {
        cacheDir: `${LOCALAPPDATA}\\Revisium\\Revo Alpha\\cache`,
        configDir: `${APPDATA}\\Revisium\\Revo Alpha\\config`,
        dataDir: `${LOCALAPPDATA}\\Revisium\\Revo Alpha\\data`,
        runtimeDir: `${LOCALAPPDATA}\\Revisium\\Revo Alpha\\state\\run`,
        stateDir: `${LOCALAPPDATA}\\Revisium\\Revo Alpha\\state`,
      },
    });
  });

  it('uses valid UNC roots and normalizes Windows separators', async () => {
    const roaming = '\\\\profiles\\users\\Revo User\\Roaming';
    const local = '\\\\profiles\\users\\Revo User\\Local';
    const configPath = `${roaming}\\Revisium\\Revo\\config\\config.json`;
    const result = await scenario(configPath, {
      env: { APPDATA: `${roaming.replaceAll('\\', '/')}\\.\\`, LOCALAPPDATA: local },
    }).resolve();

    expect(result.configPath).toBe(configPath);
    expect(result.layout.dataDir).toBe(`${local}\\Revisium\\Revo\\data`);
    expect(result.installDir).toBe(`${local}\\Revisium\\revo-install\\stable`);
  });

  it('falls back to profile roots when Windows environment roots are empty', async () => {
    const result = await scenario(STABLE_CONFIG, {
      env: { APPDATA: '', LOCALAPPDATA: '' },
    }).resolve();

    expect(result.layout.configDir).toBe(`${HOME}\\AppData\\Roaming\\Revisium\\Revo\\config`);
    expect(result.layout.dataDir).toBe(`${HOME}\\AppData\\Local\\Revisium\\Revo\\data`);
    expect(result.installDir).toBe(`${HOME}\\AppData\\Local\\Revisium\\revo-install\\stable`);
  });

  it.each([
    ['APPDATA', { APPDATA: undefined }],
    ['LOCALAPPDATA', { LOCALAPPDATA: undefined }],
  ])('falls back independently when %s is absent', async (missingRoot, env) => {
    const homeDir = 'E:\\Profiles\\Alternate User';
    const configRoot = missingRoot === 'APPDATA' ? `${homeDir}\\AppData\\Roaming` : APPDATA;
    const localRoot = missingRoot === 'LOCALAPPDATA' ? `${homeDir}\\AppData\\Local` : LOCALAPPDATA;
    const configPath = `${configRoot}\\Revisium\\Revo\\config\\config.json`;
    const result = await scenario(configPath, {
      env,
      homeDir,
    }).resolve();

    expect(result.layout.configDir).toBe(`${configRoot}\\Revisium\\Revo\\config`);
    expect(result.layout.dataDir).toBe(`${localRoot}\\Revisium\\Revo\\data`);
  });

  it('supports a UNC home and custom UNC data and log directories', async () => {
    const homeDir = '\\\\profiles\\users\\Alternate User';
    const configPath = `${homeDir}\\AppData\\Roaming\\Revisium\\Revo\\config\\config.json`;
    const result = await scenario(configPath, {
      homeDir,
      env: { APPDATA: undefined, LOCALAPPDATA: undefined },
      flags: {
        dataDir: '\\\\storage\\revo\\old\\..\\customer data',
        logDir: '//storage/revo/logs/../customer logs',
      },
    }).resolve();

    expect(result.configPath).toBe(configPath);
    expect(result.layout.dataDir).toBe('\\\\storage\\revo\\customer data');
    expect(result.logDir).toBe('\\\\storage\\revo\\customer logs');
    expect(result.installDir).toBe(`${homeDir}\\AppData\\Local\\Revisium\\revo-install\\stable`);
  });

  it('ignores XDG path variables on Windows', async () => {
    const result = await scenario(STABLE_CONFIG, {
      env: {
        XDG_CONFIG_HOME: 'relative config',
        XDG_DATA_HOME: 'relative data',
        XDG_STATE_HOME: 'relative state',
        XDG_CACHE_HOME: 'relative cache',
        XDG_RUNTIME_DIR: 'relative runtime',
      },
    }).resolve();

    expect(result.layout.configDir).toBe(`${APPDATA}\\Revisium\\Revo\\config`);
    expect(result.layout.dataDir).toBe(`${LOCALAPPDATA}\\Revisium\\Revo\\data`);
  });

  it('normalizes the selected config path before routing it to the real file loader', async () => {
    const configPath = 'D:\\Revo\\config.json';
    const subject = scenario(configPath, {
      env: { REVO_CONFIG: 'C:\\ignored\\config.json' },
      flags: { config: 'D:/Revo User/../Revo/config.json' },
      file: { schemaVersion: 1, host: 'windows.example' },
    });
    const result = await subject.resolve();

    expect(result.configPath).toBe(configPath);
    expect(result.host).toBe('windows.example');
    expect(subject.reads).toEqual([{ logicalPath: configPath, explicit: true }]);
  });

  it('selects and normalizes REVO_CONFIG with explicit-file semantics', async () => {
    const configPath = 'D:\\Revo\\environment.json';
    const subject = scenario(configPath, {
      env: { REVO_CONFIG: 'D:/Revo User/../Revo/environment.json' },
      file: { schemaVersion: 1, host: 'environment-file.example' },
    });
    const result = await subject.resolve();

    expect(result.configPath).toBe(configPath);
    expect(result.host).toBe('environment-file.example');
    expect(subject.reads).toEqual([{ logicalPath: configPath, explicit: true }]);
  });

  it('applies flag, environment, and file path precedence using Windows normalization', async () => {
    const subject = scenario(STABLE_CONFIG, {
      file: {
        schemaVersion: 1,
        dataDir: 'C:\\from file\\data',
        logDir: 'C:\\from file\\logs',
      },
      env: {
        REVO_DATA_DIR: 'relative shadowed path',
        REVO_LOG_DIR: 'F:/Environment/Logs/../Revo Logs',
      },
      flags: { dataDir: 'E:/Revo User/../Revo Data' },
    });
    const result = await subject.resolve();

    expect(result.layout.dataDir).toBe('E:\\Revo Data');
    expect(result.logDir).toBe('F:\\Environment\\Revo Logs');
    expect(subject.reads).toEqual([{ logicalPath: STABLE_CONFIG, explicit: false }]);
  });

  it('normalizes dataDir and logDir values selected only from the configuration file', async () => {
    const result = await scenario(STABLE_CONFIG, {
      file: {
        schemaVersion: 1,
        dataDir: 'C:/Revo User/../Revo Data',
        logDir: '\\\\storage\\logs\\old\\..\\Revo Logs',
      },
    }).resolve();

    expect(result.layout.dataDir).toBe('C:\\Revo Data');
    expect(result.logDir).toBe('\\\\storage\\logs\\Revo Logs');
  });

  it('allows an absent default configuration and rejects an absent explicit file', async () => {
    await expect(scenario(STABLE_CONFIG).resolve()).resolves.toMatchObject({
      configPath: STABLE_CONFIG,
    });

    const explicitPath = 'D:\\Revo\\missing.json';
    const explicit = scenario(explicitPath, { flags: { config: explicitPath } });
    await expect(explicit.resolve()).rejects.toMatchObject({
      code: 'revo.configuration.file',
      exitCode: 1,
      field: 'config',
      source: 'config-file',
    });
    expect(explicit.reads).toEqual([{ logicalPath: explicitPath, explicit: true }]);

    const environmentPath = 'D:\\Revo\\environment-missing.json';
    const missingEnvironment = scenario(environmentPath, {
      env: { REVO_CONFIG: environmentPath },
    });
    await expect(missingEnvironment.resolve()).rejects.toMatchObject({
      code: 'revo.configuration.file',
      exitCode: 1,
      field: 'config',
      source: 'config-file',
    });
    expect(missingEnvironment.reads).toEqual([{ logicalPath: environmentPath, explicit: true }]);
  });

  it('uses the real loader and resolver for malformed Windows-selected configuration', async () => {
    const secret = 'not-for-error-output';
    const subject = scenario(STABLE_CONFIG, { fileText: `{"password":"${secret}"` });
    const error = await subject.resolve().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'revo.configuration.invalid',
      exitCode: 2,
      field: 'config',
      source: 'config-file',
      cause: undefined,
    });
    expect(String(error)).not.toContain(secret);
  });

  it.each([
    ['wrong schema', { schemaVersion: 2 }, 'schemaVersion'],
    ['unknown field', { schemaVersion: 1, channel: 'alpha' }, 'channel'],
    ['wrong type', { schemaVersion: 1, port: '3210' }, 'port'],
  ])(
    'uses production schema validation through the Windows path adapter: %s',
    async (_name, file, field) => {
      const subject = scenario(STABLE_CONFIG, { file });
      const error = await subject.resolve().catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'revo.configuration.invalid',
        exitCode: 2,
        field,
        source: 'config-file',
      });
      expect(subject.reads).toEqual([{ logicalPath: STABLE_CONFIG, explicit: false }]);
    },
  );

  it.each([
    ['flags', { flags: { logDir: 'relative logs' } }],
    ['environment', { env: { REVO_LOG_DIR: 'relative logs' } }],
    ['config-file', { file: { schemaVersion: 1, logDir: 'relative logs' } }],
  ])('rejects a relative selected logDir from %s', async (source, options) => {
    const subject = scenario(STABLE_CONFIG, options);
    const error = await subject.resolve().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'revo.configuration.invalid',
      exitCode: 2,
      field: 'logDir',
      source,
    });
  });

  it.each([
    ['flags', { flags: { dataDir: 'relative data' } }],
    ['environment', { env: { REVO_DATA_DIR: 'relative data' } }],
    ['config-file', { file: { schemaVersion: 1, dataDir: 'relative data' } }],
  ])('rejects a relative selected dataDir from %s', async (source, options) => {
    const subject = scenario(STABLE_CONFIG, options);
    const error = await subject.resolve().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'revo.configuration.invalid',
      exitCode: 2,
      field: 'dataDir',
      source,
    });
  });

  it.each([
    ['homeDir', 'input', { homeDir: `C:\\home\u0000secret` }],
    ['APPDATA', 'environment', { env: { APPDATA: `C:\\roaming\u0000secret` } }],
    ['LOCALAPPDATA', 'environment', { env: { LOCALAPPDATA: `C:\\local\u0000secret` } }],
  ])(
    'rejects a NUL in Windows layout input %s before loading config',
    async (field, source, input) => {
      const subject = scenario(STABLE_CONFIG, input);
      const error = await subject.resolve().catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'revo.configuration.invalid',
        exitCode: 2,
        field,
        source,
      });
      expect(subject.reads).toEqual([]);
    },
  );

  it.each([
    ['relative path', 'relative\\config.json'],
    ['drive-relative path', 'C:relative\\config.json'],
    ['root-relative path', '\\rooted\\config.json'],
    ['slash-rooted path', '/rooted/config.json'],
    ['incomplete UNC server', '\\\\server'],
    ['incomplete UNC share', '\\\\server\\'],
    ['device namespace', '\\\\?\\C:\\private\\config.json'],
    ['device pipe namespace', '\\\\.\\pipe\\revo'],
    ['slash device namespace', '//?/C:/private/config.json'],
    ['slash device pipe namespace', '//./pipe/revo'],
    ['NUL byte', 'C:\\private\\config\u0000secret.json'],
  ])('rejects an unsafe selected Windows config path: %s', async (_label, invalidPath) => {
    const subject = scenario(STABLE_CONFIG, { flags: { config: invalidPath } });
    const error = await subject.resolve().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'revo.configuration.invalid',
      exitCode: 2,
      field: 'config',
      source: 'flags',
    });
    expect(String(error)).not.toContain(invalidPath);
    expect(subject.reads).toEqual([]);
  });

  it.each([
    ['homeDir', 'input', { homeDir: 'relative\\home' }],
    ['APPDATA', 'environment', { env: { APPDATA: 'relative\\roaming' } }],
    ['LOCALAPPDATA', 'environment', { env: { LOCALAPPDATA: 'C:relative\\local' } }],
  ])(
    'rejects invalid Windows layout input %s before loading config',
    async (field, source, input) => {
      const subject = scenario(STABLE_CONFIG, input);
      const error = await subject.resolve().catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'revo.configuration.invalid',
        exitCode: 2,
        field,
        source,
      });
      expect(subject.reads).toEqual([]);
    },
  );

  it('rejects a custom data path containing NUL without exposing it', async () => {
    const invalidPath = 'D:\\Revo\\data\u0000secret';
    const subject = scenario(STABLE_CONFIG, { flags: { dataDir: invalidPath } });
    const error = await subject.resolve().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'revo.configuration.invalid',
      exitCode: 2,
      field: 'dataDir',
      source: 'flags',
    });
    expect(String(error)).not.toContain(invalidPath);
  });

  it.each(['\\\\server\\.\\data', '\\\\server\\..\\data', '\\\\..\\share\\data'])(
    'rejects a UNC path without an ordinary server and share: %s',
    async (dataDir) => {
      const subject = scenario(STABLE_CONFIG, { flags: { dataDir } });
      const error = await subject.resolve().catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'revo.configuration.invalid',
        exitCode: 2,
        field: 'dataDir',
        source: 'flags',
      });
    },
  );

  it('keeps resolver inputs immutable and freezes the complete result', async () => {
    const subject = scenario(STABLE_CONFIG, {
      env: { REVO_PORT: '4400' },
      flags: { logDir: 'D:\\Revo\\logs' },
    });
    const result = await subject.resolve();

    expect(result.port).toBe(4400);
    expect(result.logDir).toBe('D:\\Revo\\logs');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.layout)).toBe(true);
  });

  it('keeps installation and other channel roots independent from a custom data path', async () => {
    const result = await scenario(STABLE_CONFIG, {
      flags: { dataDir: 'D:\\Customer Data\\revo' },
    }).resolve();

    expect(result.layout.dataDir).toBe('D:\\Customer Data\\revo');
    expect(result.layout.configDir).toBe(`${APPDATA}\\Revisium\\Revo\\config`);
    expect(result.layout.stateDir).toBe(`${LOCALAPPDATA}\\Revisium\\Revo\\state`);
    expect(result.installDir).toBe(`${LOCALAPPDATA}\\Revisium\\revo-install\\stable`);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.layout)).toBe(true);
  });
});
