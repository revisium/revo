export const PROGRESS_SCHEMA_VERSION = 'revo-progress/v1' as const;

export const PROGRESS_PHASES = [
  'application-database-migrations',
  'dbos-system-migrations',
  'application-bootstrap',
  'api-readiness',
  'server-start',
  'postgres-binary-prepare',
  'postgres-initialization',
  'postgres-start',
  'runtime-download',
  'runtime-extract',
  'dependencies-install',
  'installation-activate',
] as const;

export type ProgressPhase = string;
export type ProgressStatus = 'started' | 'progress' | 'completed' | 'failed' | 'ready';
export interface ProgressCounters {
  readonly bytesReceived?: number;
  readonly bytesTotal?: number;
  readonly pnpmResolved?: number;
  readonly pnpmReused?: number;
  readonly pnpmDownloaded?: number;
  readonly pnpmAdded?: number;
}

export interface ProgressEvent {
  readonly schemaVersion: typeof PROGRESS_SCHEMA_VERSION;
  readonly operationId: string;
  readonly sequence: number;
  readonly phase: ProgressPhase;
  readonly status: ProgressStatus;
  readonly elapsedMs: number;
  readonly counters?: ProgressCounters;
  readonly stageElapsedMs?: number;
  readonly code?: string;
  readonly logPath?: string;
  readonly url?: string;
  readonly reused?: true;
}
