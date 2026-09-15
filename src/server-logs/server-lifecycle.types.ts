export const SERVER_LIFECYCLE_FILE = 'server-lifecycle.json' as const;
export const SERVER_LIFECYCLE_TEMP_FILE = '.server-lifecycle.tmp' as const;
export const SERVER_LIFECYCLE_SCHEMA_VERSION = 1 as const;
export const SERVER_LIFECYCLE_RETAIN = 128;
export const MAX_SERVER_LIFECYCLE_EVENT_BYTES = 384;
export const MAX_SERVER_LIFECYCLE_DOCUMENT_BYTES = 65_536;
export const SERVER_LIFECYCLE_READER_BYTES = MAX_SERVER_LIFECYCLE_DOCUMENT_BYTES + 1;
export const SERVER_LIFECYCLE_MAX_PENDING_WRITES = 128;

export const SERVER_LIFECYCLE_CORE_PHASES = [
  'application-database-migrations',
  'dbos-system-migrations',
  'application-bootstrap',
  'api-readiness',
] as const;

export type ServerLifecycleCorePhase = (typeof SERVER_LIFECYCLE_CORE_PHASES)[number];
export type ServerLifecyclePhase = 'server' | 'postgres' | 'shutdown' | ServerLifecycleCorePhase;
export type ServerLifecycleState =
  | 'starting'
  | 'started'
  | 'ready'
  | 'completed'
  | 'failed'
  | 'stopping'
  | 'stopped'
  | 'cancelled';

export type ServerLifecycleCode =
  | 'SERVER_STARTING'
  | 'DATABASE_STARTING'
  | 'DATABASE_READY'
  | 'DATABASE_FAILED'
  | 'CORE_STAGE_STARTED'
  | 'CORE_STAGE_COMPLETED'
  | 'CORE_STAGE_FAILED'
  | 'SERVER_READY'
  | 'SERVER_STOPPING'
  | 'SERVER_RESOURCES_STOPPED'
  | 'SERVER_CANCELLED'
  | 'SERVER_CORE_FAILED'
  | 'SERVER_READINESS_FAILED'
  | 'SERVER_START_FAILED'
  | 'SERVER_STOP_FAILED';

export interface ServerLifecycleEvent {
  readonly sequence: number;
  readonly time: number;
  readonly phase: ServerLifecyclePhase;
  readonly state: ServerLifecycleState;
  readonly code: ServerLifecycleCode;
}

export interface ServerLifecycleDocument {
  readonly schemaVersion: typeof SERVER_LIFECYCLE_SCHEMA_VERSION;
  readonly events: readonly ServerLifecycleEvent[];
}

export interface ServerLifecycleConfiguration {
  readonly logDir: string;
  readonly canonicalDataDir: string;
  readonly channel: 'stable' | 'alpha';
  readonly now?: () => number;
}

export interface ServerLifecycleSink {
  emit(code: ServerLifecycleCode, corePhase?: ServerLifecycleCorePhase): Promise<void>;
  close(): Promise<void>;
}

export class ServerLifecycleError extends Error {
  readonly code = 'SERVER_LIFECYCLE_ERROR';

  constructor(readonly reason: 'invalid' | 'limit' | 'io' | 'closed' | 'unsafe') {
    super('Server lifecycle journal failed');
    this.name = 'ServerLifecycleError';
  }
}
