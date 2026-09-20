import net from 'node:net';
import path from 'node:path';

import { resolveRevoLayout, type ReleaseChannel } from '../layout.js';
import { ConfigFileLoader } from './config-file-loader.js';
import { invalidConfiguration } from './configuration-error.js';
import {
  MAX_STARTUP_TIMEOUT_MILLISECONDS,
  type ConfigurationFile,
  type ConfigurationFlags,
  type ConfigurationInput,
  type RevoConfiguration,
} from './configuration.types.js';

const FILE_KEYS = new Set([
  'schemaVersion',
  'host',
  'port',
  'publicUrl',
  'databaseUrl',
  'dataDir',
  'logDir',
  'startupTimeout',
]);
const ENV_FIELDS = {
  databaseUrl: 'REVO_DATABASE_URL',
  dataDir: 'REVO_DATA_DIR',
  host: 'REVO_HOST',
  logDir: 'REVO_LOG_DIR',
  port: 'REVO_PORT',
  publicUrl: 'REVO_PUBLIC_URL',
  startupTimeout: 'REVO_STARTUP_TIMEOUT',
} as const;

type ValueField = keyof typeof ENV_FIELDS;
type ConfigurationValue = string | number | undefined;
type PathApi = Pick<typeof path.posix, 'isAbsolute' | 'join' | 'normalize'>;

export class ConfigurationResolver {
  constructor(private readonly fileLoader = new ConfigFileLoader()) {}

  async resolve(input: Readonly<ConfigurationInput>): Promise<Readonly<RevoConfiguration>> {
    const channel = this.channel(input);
    const pathApi = input.platform === 'win32' ? path.win32 : path.posix;
    this.layoutPaths(input, pathApi);
    const baseLayout = resolveRevoLayout({
      channel,
      env: input.env,
      homeDir: input.homeDir,
      platform: input.platform,
    });
    const explicitPath = input.flags.config ?? input.env.REVO_CONFIG;
    const requestedConfigPath = explicitPath ?? pathApi.join(baseLayout.configDir, 'config.json');
    const normalizedConfigPath = this.absolutePath(
      requestedConfigPath,
      'config',
      this.configPathSource(input),
      pathApi,
      input.platform,
    );
    const configPath = input.platform === 'win32' ? normalizedConfigPath : requestedConfigPath;
    const file = this.configurationFile(
      await this.fileLoader.read(configPath, explicitPath !== undefined),
    );
    const host = this.host(
      this.value('host', input.flags, input.env, file) ?? '127.0.0.1',
      this.source('host', input.flags, input.env, file),
    );
    const port = this.integer(
      this.value('port', input.flags, input.env, file) ?? (channel === 'alpha' ? 3211 : 3210),
      'port',
      65_535,
      this.source('port', input.flags, input.env, file),
    );
    const startupTimeout = this.integer(
      this.value('startupTimeout', input.flags, input.env, file) ?? 180_000,
      'startupTimeout',
      MAX_STARTUP_TIMEOUT_MILLISECONDS,
      this.source('startupTimeout', input.flags, input.env, file),
    );
    const dataDir = this.optionalPath(
      this.value('dataDir', input.flags, input.env, file),
      'dataDir',
      this.source('dataDir', input.flags, input.env, file),
      pathApi,
      input.platform,
    );
    const logDir =
      this.optionalPath(
        this.value('logDir', input.flags, input.env, file),
        'logDir',
        this.source('logDir', input.flags, input.env, file),
        pathApi,
        input.platform,
      ) ?? pathApi.join(baseLayout.stateDir, 'logs');
    const databaseUrl = this.databaseUrl(
      this.value('databaseUrl', input.flags, input.env, file),
      this.source('databaseUrl', input.flags, input.env, file),
    );
    const publicUrl = this.publicUrl(
      this.value('publicUrl', input.flags, input.env, file),
      port,
      this.source('publicUrl', input.flags, input.env, file),
    );
    const layout = Object.freeze({ ...baseLayout, dataDir: dataDir ?? baseLayout.dataDir });

    return Object.freeze({
      channel,
      configPath,
      ...(databaseUrl === undefined ? {} : { databaseUrl }),
      host,
      installDir:
        input.platform === 'win32'
          ? pathApi.join(
              input.env.LOCALAPPDATA || pathApi.join(input.homeDir, 'AppData', 'Local'),
              'Revisium',
              'revo-install',
              channel,
            )
          : pathApi.join(input.homeDir, '.local', 'share', 'revo-install', channel),
      layout,
      logDir,
      port,
      publicUrl,
      startupTimeout,
    });
  }

  private channel(input: Readonly<ConfigurationInput>): ReleaseChannel {
    const selected =
      input.flags.channel ??
      input.env.REVO_CHANNEL ??
      (input.wrapperChannel === 'alpha' ? 'alpha' : this.packageChannel(input.packageVersion));
    if (selected !== 'stable' && selected !== 'alpha') {
      invalidConfiguration(
        'channel',
        input.flags.channel === undefined ? 'environment' : 'flags',
        'must be stable or alpha',
      );
    }
    if (input.wrapperChannel === 'alpha' && selected !== 'alpha') {
      invalidConfiguration('channel', 'wrapper', 'alpha wrapper cannot select stable');
    }
    return selected;
  }

  private packageChannel(version: string): ReleaseChannel {
    return /^\d+\.\d+\.\d+-/u.test(version) ? 'alpha' : 'stable';
  }

  private configurationFile(value: unknown): Readonly<ConfigurationFile> {
    if (value === undefined) {
      return { schemaVersion: 1 };
    }
    if (!this.isRecord(value)) {
      invalidConfiguration('config', 'config-file', 'must be an object');
    }
    const record = value;
    this.validateFileKeys(record);
    this.validateFileTypes(record);
    return this.toConfigurationFile(record);
  }

  private validateFileKeys(record: Readonly<Record<string, unknown>>): void {
    for (const key of Object.keys(record)) {
      if (!FILE_KEYS.has(key)) {
        invalidConfiguration(key, 'config-file', 'is not supported');
      }
    }
    if (record.schemaVersion !== 1) {
      invalidConfiguration('schemaVersion', 'config-file', 'must be 1');
    }
  }

  private validateFileTypes(record: Readonly<Record<string, unknown>>): void {
    for (const key of ['host', 'publicUrl', 'databaseUrl', 'dataDir', 'logDir'] as const) {
      if (record[key] !== undefined && typeof record[key] !== 'string') {
        invalidConfiguration(key, 'config-file', 'must be a string');
      }
    }
    for (const key of ['port', 'startupTimeout'] as const) {
      if (record[key] !== undefined && typeof record[key] !== 'number') {
        invalidConfiguration(key, 'config-file', 'must be a number');
      }
    }
  }

  private toConfigurationFile(
    record: Readonly<Record<string, unknown>>,
  ): Readonly<ConfigurationFile> {
    return {
      schemaVersion: 1,
      ...(typeof record.databaseUrl === 'string' ? { databaseUrl: record.databaseUrl } : {}),
      ...(typeof record.dataDir === 'string' ? { dataDir: record.dataDir } : {}),
      ...(typeof record.host === 'string' ? { host: record.host } : {}),
      ...(typeof record.logDir === 'string' ? { logDir: record.logDir } : {}),
      ...(typeof record.port === 'number' ? { port: record.port } : {}),
      ...(typeof record.publicUrl === 'string' ? { publicUrl: record.publicUrl } : {}),
      ...(typeof record.startupTimeout === 'number'
        ? { startupTimeout: record.startupTimeout }
        : {}),
    };
  }

  private value(
    field: ValueField,
    flags: Readonly<ConfigurationFlags>,
    env: Readonly<Record<string, string | undefined>>,
    file: Readonly<ConfigurationFile>,
  ): ConfigurationValue {
    return flags[field] ?? env[ENV_FIELDS[field]] ?? file[field];
  }

  private source(
    field: ValueField,
    flags: Readonly<ConfigurationFlags>,
    env: Readonly<Record<string, string | undefined>>,
    file: Readonly<ConfigurationFile>,
  ): string {
    if (flags[field] !== undefined) {
      return 'flags';
    }
    if (env[ENV_FIELDS[field]] !== undefined) {
      return 'environment';
    }
    if (file[field] !== undefined) {
      return 'config-file';
    }
    return 'default';
  }

  private integer(value: string | number, field: string, maximum: number, source: string): number {
    let number = value;
    if (typeof number === 'string') {
      number = number === '' ? Number.NaN : Number(number);
    }
    if (!Number.isInteger(number) || number < 1 || number > maximum) {
      invalidConfiguration(field, source, `must be an integer between 1 and ${maximum}`);
    }
    return number;
  }

  private host(value: string | number, source: string): string {
    if (typeof value !== 'string' || value === '') {
      invalidConfiguration('host', source, 'must be a hostname or IP literal');
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      const literal = value.slice(1, -1);
      if (net.isIP(literal) === 6) {
        return literal;
      }
      invalidConfiguration('host', source, 'must be a hostname or IP literal');
    }
    if (net.isIP(value) !== 0) {
      return value;
    }
    const valid =
      value.length <= 253 &&
      value
        .split('.')
        .every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label));
    if (!valid) {
      invalidConfiguration('host', source, 'must be a hostname or IP literal');
    }
    return value;
  }

  private publicUrl(value: ConfigurationValue, port: number, source: string): string {
    if (value === undefined) {
      return `http://127.0.0.1:${port}`;
    }
    if (typeof value !== 'string') {
      invalidConfiguration('publicUrl', source, 'must be an HTTP(S) origin');
    }
    try {
      const url = new URL(value);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.pathname !== '' && url.pathname !== '/')
      ) {
        throw new Error('Not an HTTP(S) origin');
      }
      return url.origin;
    } catch {
      return invalidConfiguration('publicUrl', source, 'must be an HTTP(S) origin');
    }
  }

  private databaseUrl(value: string | number | undefined, source: string): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string') {
      invalidConfiguration('databaseUrl', source, 'must be a PostgreSQL URL');
    }
    try {
      const url = new URL(value);
      if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname) {
        throw new Error('Not a PostgreSQL URL');
      }
      return value;
    } catch {
      return invalidConfiguration('databaseUrl', source, 'must be a PostgreSQL URL');
    }
  }

  private optionalPath(
    value: string | number | undefined,
    field: string,
    source: string,
    pathApi: PathApi,
    platform: ConfigurationInput['platform'],
  ): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string') {
      invalidConfiguration(field, source, 'must be an absolute path');
    }
    return this.absolutePath(value, field, source, pathApi, platform);
  }

  private absolutePath(
    value: string,
    field: string,
    source: string,
    pathApi: PathApi,
    platform: ConfigurationInput['platform'],
  ): string {
    if (value.includes('\0')) {
      invalidConfiguration(field, source, 'must be an absolute path');
    }
    if (platform !== 'win32') {
      if (!pathApi.isAbsolute(value)) {
        invalidConfiguration(field, source, 'must be an absolute path');
      }
      return pathApi.normalize(value);
    }

    const windowsPath = value.replaceAll('/', '\\');
    const isDeviceNamespace = /^\\\\[?.]\\/u.test(windowsPath);
    const isDriveQualified = /^[A-Za-z]:\\/u.test(windowsPath);
    const uncRoot = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/u.exec(windowsPath);
    const isUncPath =
      uncRoot !== null &&
      uncRoot[1] !== '.' &&
      uncRoot[1] !== '..' &&
      uncRoot[2] !== '.' &&
      uncRoot[2] !== '..';
    if (isDeviceNamespace || (!isDriveQualified && !isUncPath) || !pathApi.isAbsolute(value)) {
      invalidConfiguration(field, source, 'must be an absolute path');
    }
    return pathApi.normalize(value);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private layoutPaths(input: Readonly<ConfigurationInput>, pathApi: PathApi): void {
    this.absolutePath(input.homeDir, 'homeDir', 'input', pathApi, input.platform);
    if (input.platform === 'win32') {
      for (const field of ['APPDATA', 'LOCALAPPDATA'] as const) {
        const value = input.env[field];
        if (value !== undefined && value !== '') {
          this.absolutePath(value, field, 'environment', pathApi, input.platform);
        }
      }
      return;
    }
    if (input.platform !== 'linux') {
      return;
    }
    for (const field of [
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
      'XDG_RUNTIME_DIR',
    ] as const) {
      const value = input.env[field];
      if (value !== undefined && value !== '') {
        this.absolutePath(value, field, 'environment', pathApi, input.platform);
      }
    }
  }

  private configPathSource(input: Readonly<ConfigurationInput>): string {
    if (input.flags.config !== undefined) {
      return 'flags';
    }
    if (input.env.REVO_CONFIG !== undefined) {
      return 'environment';
    }
    return 'default';
  }
}
