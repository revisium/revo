import net from 'node:net';
import { isAbsolute } from 'node:path';

import { MAX_STARTUP_TIMEOUT_MILLISECONDS } from '../configuration/configuration.types.js';
import type { ServerOwnerConfiguration } from './server-owner.service.js';

export const SERVER_HOST_PROTOCOL = 'revo-server-host/v1' as const;

export type ServerHostMode = 'detached' | 'foreground';

export interface ServerHostStartMessage {
  readonly protocol: typeof SERVER_HOST_PROTOCOL;
  readonly type: 'start';
  readonly operationId: string;
  readonly mode: ServerHostMode;
  readonly configuration: ServerOwnerConfiguration;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ServerHostCommitMessage {
  readonly protocol: typeof SERVER_HOST_PROTOCOL;
  readonly type: 'commit';
  readonly operationId: string;
}

export interface ServerHostCancelMessage {
  readonly protocol: typeof SERVER_HOST_PROTOCOL;
  readonly type: 'cancel';
  readonly operationId: string;
}

export type ServerHostParentMessage =
  | ServerHostStartMessage
  | ServerHostCommitMessage
  | ServerHostCancelMessage;

export type ServerHostFailureCode =
  | 'SERVER_HOST_BUSY'
  | 'SERVER_HOST_CANCELLED'
  | 'SERVER_HOST_FAILED'
  | 'SERVER_HOST_INVALID_MESSAGE'
  | 'SERVER_HOST_WRONG_OPERATION';

export type ServerHostChildMessage =
  | { readonly protocol: typeof SERVER_HOST_PROTOCOL; readonly type: 'booted' }
  | {
      readonly protocol: typeof SERVER_HOST_PROTOCOL;
      readonly type: 'ready';
      readonly operationId: string;
      readonly url: string;
    }
  | {
      readonly protocol: typeof SERVER_HOST_PROTOCOL;
      readonly type: 'committed';
      readonly operationId: string;
    }
  | {
      readonly protocol: typeof SERVER_HOST_PROTOCOL;
      readonly type: 'failed';
      readonly operationId?: string;
      readonly code: ServerHostFailureCode;
      readonly cleanup?: 'completed' | 'retained' | 'unconfirmed';
    };

const START_FIELDS = ['protocol', 'type', 'operationId', 'mode', 'configuration', 'environment'];
const OPERATION_FIELDS = ['protocol', 'type', 'operationId'];
const CONFIGURATION_FIELDS = [
  'channel',
  'dataDir',
  'host',
  'logDir',
  'port',
  'publicUrl',
  'runtimeDir',
  'startupTimeout',
  'version',
];
const MAX_SERIALIZED_BYTES = 256 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ENVIRONMENT_KEY_LENGTH = 128;
const MAX_ENVIRONMENT_VALUE_LENGTH = 32 * 1024;
const SEMVER_IDENTIFIER = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(
  String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(${SEMVER_IDENTIFIER}(?:\.${SEMVER_IDENTIFIER})*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
);

export function parseServerHostParentMessage(value: unknown): ServerHostParentMessage | undefined {
  if (!boundedSerialization(value)) {
    return undefined;
  }
  if (!record(value) || value.protocol !== SERVER_HOST_PROTOCOL) {
    return undefined;
  }
  if (value.type === 'commit' || value.type === 'cancel') {
    return exact(value, OPERATION_FIELDS) && operationId(value.operationId)
      ? { protocol: SERVER_HOST_PROTOCOL, type: value.type, operationId: value.operationId }
      : undefined;
  }
  if (
    value.type !== 'start' ||
    !exact(value, START_FIELDS) ||
    !operationId(value.operationId) ||
    (value.mode !== 'detached' && value.mode !== 'foreground')
  ) {
    return undefined;
  }
  const configuration = parseConfiguration(value.configuration);
  const environment = parseEnvironment(value.environment);
  return configuration && environment
    ? {
        protocol: SERVER_HOST_PROTOCOL,
        type: 'start',
        operationId: value.operationId,
        mode: value.mode,
        configuration,
        environment,
      }
    : undefined;
}

function parseConfiguration(value: unknown): ServerOwnerConfiguration | undefined {
  if (!record(value) || !exact(value, CONFIGURATION_FIELDS, ['databaseUrl'])) {
    return undefined;
  }
  if (
    (value.channel !== 'stable' && value.channel !== 'alpha') ||
    !absolute(value.dataDir) ||
    !absolute(value.logDir) ||
    !host(value.host) ||
    !port(value.port) ||
    !publicOrigin(value.publicUrl) ||
    !absolute(value.runtimeDir) ||
    !duration(value.startupTimeout) ||
    typeof value.version !== 'string' ||
    !SEMVER.test(value.version) ||
    (value.databaseUrl !== undefined && !postgresUrl(value.databaseUrl))
  ) {
    return undefined;
  }
  return {
    channel: value.channel,
    dataDir: value.dataDir,
    logDir: value.logDir,
    ...(value.databaseUrl === undefined ? {} : { databaseUrl: value.databaseUrl }),
    host: value.host,
    port: value.port,
    publicUrl: value.publicUrl,
    runtimeDir: value.runtimeDir,
    startupTimeout: value.startupTimeout,
    version: value.version,
  };
}

function parseEnvironment(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!record(value) || Object.keys(value).length > MAX_ENVIRONMENT_ENTRIES) {
    return undefined;
  }
  const entries: [string, string][] = [];
  for (const [name, environmentValue] of Object.entries(value)) {
    if (
      !environmentName(name) ||
      typeof environmentValue !== 'string' ||
      environmentValue.length > MAX_ENVIRONMENT_VALUE_LENGTH ||
      environmentValue.includes('\0')
    ) {
      return undefined;
    }
    entries.push([name, environmentValue]);
  }
  return Object.fromEntries(entries);
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (
  value: Record<string, unknown>,
  fields: readonly string[],
  optional: readonly string[] = [],
) => {
  const keys = Object.keys(value);
  return (
    keys.length >= fields.length &&
    keys.length <= fields.length + optional.length &&
    fields.every((field) => keys.includes(field)) &&
    keys.every((field) => fields.includes(field) || optional.includes(field))
  );
};
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.split('').every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f;
  });
const operationId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value);
const absolute = (value: unknown): value is string => text(value) && isAbsolute(value);
const port = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 65_535;
const duration = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  Number(value) > 0 &&
  Number(value) <= MAX_STARTUP_TIMEOUT_MILLISECONDS;
const environmentName = (value: string) =>
  value.length <= MAX_ENVIRONMENT_KEY_LENGTH && /^[A-Za-z_]\w*$/u.test(value);

function host(value: unknown): value is string {
  if (!text(value)) {
    return false;
  }
  if (net.isIP(value) !== 0) {
    return true;
  }
  return (
    value.length <= 253 &&
    value
      .split('.')
      .every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))
  );
}

function publicOrigin(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === '' || url.pathname === '/') &&
      url.origin === value.replace(/\/$/u, '')
    );
  } catch {
    return false;
  }
}

function postgresUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

function boundedSerialization(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && Buffer.byteLength(serialized) <= MAX_SERIALIZED_BYTES;
  } catch {
    return false;
  }
}
