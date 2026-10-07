export const PROGRESS_SCHEMA_VERSION = 'revo-progress/v1' as const;

export type ProgressStatus = 'started' | 'progress' | 'completed' | 'failed' | 'ready';

export interface ProgressEvent {
  readonly schemaVersion: typeof PROGRESS_SCHEMA_VERSION;
  readonly operationId: string;
  readonly sequence: number;
  readonly phase: string;
  readonly status: ProgressStatus;
  readonly elapsedMs: number;
  readonly stageElapsedMs?: number;
  readonly code?: string;
  readonly logPath?: string;
  readonly url?: string;
  readonly reused?: true;
}
