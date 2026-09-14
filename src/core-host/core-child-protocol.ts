export const CORE_HOST_PROTOCOL = 'revo-core-host/v1' as const;

export type CoreHostLifecycleStage =
  | 'application-database-migrations'
  | 'dbos-system-migrations'
  | 'application-bootstrap'
  | 'api-readiness';

export type CoreHostStageStatus = 'started' | 'completed' | 'failed';

export interface CoreHostHelloMessage {
  readonly protocol: typeof CORE_HOST_PROTOCOL;
  readonly type: 'hello';
}

export interface CoreHostBootedMessage {
  readonly protocol: typeof CORE_HOST_PROTOCOL;
  readonly type: 'booted';
}

export interface CoreHostStartMessage {
  readonly protocol: typeof CORE_HOST_PROTOCOL;
  readonly type: 'start';
  readonly databaseUrl: string;
  readonly temporaryWorkingDirectoryRoot: string;
  readonly agentWorkspaceDirectory: string;
  readonly host: string;
  readonly port: number;
}

export interface CoreHostShutdownMessage {
  readonly protocol: typeof CORE_HOST_PROTOCOL;
  readonly type: 'shutdown';
}

export interface CoreHostStageMessage {
  readonly protocol: typeof CORE_HOST_PROTOCOL;
  readonly type: 'stage';
  readonly stage: CoreHostLifecycleStage;
  readonly status: CoreHostStageStatus;
  readonly code?: 'CORE_STAGE_FAILED';
}

export interface CoreHostListeningMessage {
  readonly protocol: typeof CORE_HOST_PROTOCOL;
  readonly type: 'listening';
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

export interface CoreHostFailedMessage {
  readonly protocol: typeof CORE_HOST_PROTOCOL;
  readonly type: 'failed';
  readonly code: 'CORE_STAGE_FAILED' | 'CORE_HOST_FAILED';
}

export type CoreHostMessage =
  | CoreHostHelloMessage
  | CoreHostBootedMessage
  | CoreHostStartMessage
  | CoreHostShutdownMessage
  | CoreHostStageMessage
  | CoreHostListeningMessage
  | CoreHostFailedMessage;

const stages = new Set<unknown>([
  'application-database-migrations',
  'dbos-system-migrations',
  'application-bootstrap',
  'api-readiness',
]);
const types = new Set<string>([
  'hello',
  'booted',
  'start',
  'shutdown',
  'stage',
  'listening',
  'failed',
]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const safeText = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) {
      return false;
    }
  }
  return true;
};
const absolutePath = (value: unknown): value is string => safeText(value) && value.startsWith('/');
const validPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
const validListenRequestPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 65_535;

export const parseCoreHostMessage = (value: unknown): CoreHostMessage | undefined => {
  if (!isRecord(value) || value.protocol !== CORE_HOST_PROTOCOL || typeof value.type !== 'string') {
    return undefined;
  }
  if (!types.has(value.type)) {
    return undefined;
  }
  switch (value.type) {
    case 'hello':
      return hasOnly(value, ['protocol', 'type'])
        ? { protocol: CORE_HOST_PROTOCOL, type: 'hello' }
        : undefined;
    case 'booted':
      return hasOnly(value, ['protocol', 'type'])
        ? { protocol: CORE_HOST_PROTOCOL, type: 'booted' }
        : undefined;
    case 'shutdown':
      return hasOnly(value, ['protocol', 'type'])
        ? { protocol: CORE_HOST_PROTOCOL, type: 'shutdown' }
        : undefined;
    case 'start':
      return parseStart(value);
    case 'stage':
      return parseStage(value);
    case 'listening':
      return hasOnly(value, ['protocol', 'type', 'host', 'port', 'url']) &&
        safeText(value.host) &&
        validPort(value.port) &&
        safeText(value.url)
        ? {
            protocol: CORE_HOST_PROTOCOL,
            type: 'listening',
            host: value.host,
            port: value.port,
            url: value.url,
          }
        : undefined;
    case 'failed':
      return hasOnly(value, ['protocol', 'type', 'code']) &&
        (value.code === 'CORE_STAGE_FAILED' || value.code === 'CORE_HOST_FAILED')
        ? { protocol: CORE_HOST_PROTOCOL, type: 'failed', code: value.code }
        : undefined;
  }
  return undefined;
};

export const isCoreHostMessage = (value: unknown): value is CoreHostMessage =>
  parseCoreHostMessage(value) !== undefined;

function parseStart(value: Record<string, unknown>): CoreHostStartMessage | undefined {
  if (
    !hasOnly(value, [
      'protocol',
      'type',
      'databaseUrl',
      'temporaryWorkingDirectoryRoot',
      'agentWorkspaceDirectory',
      'host',
      'port',
    ]) ||
    !safeText(value.databaseUrl) ||
    !absolutePath(value.temporaryWorkingDirectoryRoot) ||
    !absolutePath(value.agentWorkspaceDirectory) ||
    !safeText(value.host) ||
    !validListenRequestPort(value.port)
  ) {
    return undefined;
  }
  return {
    protocol: CORE_HOST_PROTOCOL,
    type: 'start',
    databaseUrl: value.databaseUrl,
    temporaryWorkingDirectoryRoot: value.temporaryWorkingDirectoryRoot,
    agentWorkspaceDirectory: value.agentWorkspaceDirectory,
    host: value.host,
    port: value.port,
  };
}

function isStage(value: unknown): value is CoreHostLifecycleStage {
  return stages.has(value);
}

function parseStage(value: Record<string, unknown>): CoreHostStageMessage | undefined {
  if (!isStage(value.stage) || !hasOnly(value, ['protocol', 'type', 'stage', 'status', 'code'])) {
    return undefined;
  }
  if (value.status === 'started' || value.status === 'completed') {
    return value.code === undefined
      ? { protocol: CORE_HOST_PROTOCOL, type: 'stage', stage: value.stage, status: value.status }
      : undefined;
  }
  return value.status === 'failed' && value.code === 'CORE_STAGE_FAILED'
    ? {
        protocol: CORE_HOST_PROTOCOL,
        type: 'stage',
        stage: value.stage,
        status: 'failed',
        code: 'CORE_STAGE_FAILED',
      }
    : undefined;
}
