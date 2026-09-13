import type { ProgressCounters, ProgressEvent } from '../progress/index.js';

export const STARTUP_PROGRESS_FILE = '.revo-progress.json';
export const STARTUP_PROGRESS_SCHEMA_VERSION = 'revo-startup-progress/v1' as const;
export const MAX_STARTUP_PROGRESS_BYTES = 256 * 1024;
export const TERMINAL_PROGRESS_RESERVE_BYTES = 16 * 1024;
export const MAX_NONTERMINAL_TRANSITIONS = 255;

export interface StartupProgressOptions {
  readonly operationId: string;
  readonly now: () => number;
}

export interface StartupProgressCursor {
  readonly operationId: string;
  readonly sequence: number;
}

export type StartupProgressRead =
  | {
      readonly kind: 'events';
      readonly operationId: string;
      readonly events: readonly ProgressEvent[];
    }
  | { readonly kind: 'operation-changed'; readonly operationId: string }
  | { readonly kind: 'missing' | 'invalid' | 'unavailable' };

export interface StartupProgressFacade {
  start(phase: string): Promise<ProgressEvent>;
  progress(
    phase: string,
    details?: { readonly counters?: ProgressCounters; readonly stageElapsedMs?: number },
  ): Promise<ProgressEvent>;
  complete(phase: string): Promise<ProgressEvent>;
  fail(
    phase: string,
    details: { readonly code: string; readonly logPath?: string },
  ): Promise<ProgressEvent>;
  ready(details: { readonly url: string; readonly reused?: true }): Promise<ProgressEvent>;
}

export class StartupProgressError extends Error {
  readonly code = 'STARTUP_PROGRESS_ERROR';
  constructor(readonly reason: 'closed' | 'invalid' | 'limit' | 'io') {
    super('Startup progress journal failed');
    this.name = 'StartupProgressError';
  }
}
