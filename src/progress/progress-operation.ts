import {
  PROGRESS_SCHEMA_VERSION,
  type ProgressCounters,
  type ProgressEvent,
} from './progress-event.js';
import { parseProgressEvent } from './progress-event.parser.js';

export class ProgressOperation {
  private readonly origin: number;
  private readonly history: ProgressEvent[] = [];
  private readonly phaseStarted = new Map<string, number>();
  private readonly phaseElapsed = new Map<string, number>();
  private lastElapsed = 0;
  private sequence = 0;
  private terminal = false;

  constructor(
    private readonly options: { readonly operationId: string; readonly now: () => number },
  ) {
    this.origin = options.now();
  }
  start(phase: string) {
    return this.emit(phase, 'started', {});
  }
  progress(
    phase: string,
    details: { readonly counters?: ProgressCounters; readonly stageElapsedMs?: number } = {},
  ) {
    return this.emit(phase, 'progress', details);
  }
  complete(phase: string) {
    return this.emit(phase, 'completed', {});
  }
  fail(phase: string, details: { readonly code: string; readonly logPath?: string }) {
    return this.emit(phase, 'failed', details, true);
  }
  /** Caller declares ownership, control identity, and the real readiness probe already complete. */
  ready(details: { readonly url: string; readonly reused?: true }) {
    return this.emit('server-start', 'ready', details, true);
  }
  eventsAfter(sequence: number): readonly ProgressEvent[] {
    return Object.freeze(this.history.filter((event) => event.sequence > sequence));
  }

  private emit(phase: string, status: ProgressEvent['status'], details: object, terminal = false) {
    if (this.terminal) {
      return undefined;
    }
    const suppliedStageElapsed = 'stageElapsedMs' in details ? details.stageElapsedMs : undefined;
    if (
      suppliedStageElapsed !== undefined &&
      (typeof suppliedStageElapsed !== 'number' ||
        !Number.isFinite(suppliedStageElapsed) ||
        suppliedStageElapsed < 0)
    ) {
      throw new Error('Invalid progress event input');
    }
    const elapsedMs = Math.max(this.lastElapsed, Math.max(0, this.options.now() - this.origin));
    let stageElapsedMs: number | undefined;
    if (status === 'completed') {
      stageElapsedMs = this.nextStageElapsed(
        phase,
        elapsedMs - (this.phaseStarted.get(phase) ?? elapsedMs),
      );
    } else if (typeof suppliedStageElapsed === 'number') {
      stageElapsedMs = this.nextStageElapsed(phase, suppliedStageElapsed);
    }
    const candidate = {
      schemaVersion: PROGRESS_SCHEMA_VERSION,
      operationId: this.options.operationId,
      sequence: this.sequence + 1,
      phase,
      status,
      elapsedMs,
      ...details,
      ...(stageElapsedMs === undefined ? {} : { stageElapsedMs }),
    };
    const parsed = parseProgressEvent(candidate);
    if (!parsed) {
      throw new Error('Invalid progress event input');
    }
    this.lastElapsed = elapsedMs;
    this.sequence = parsed.sequence;
    if (status === 'started') {
      this.phaseStarted.set(phase, elapsedMs);
      this.phaseElapsed.set(phase, 0);
    } else if (stageElapsedMs !== undefined) {
      this.phaseElapsed.set(phase, stageElapsedMs);
    }
    const event = Object.freeze({
      ...parsed,
      ...(parsed.counters ? { counters: Object.freeze({ ...parsed.counters }) } : {}),
    });
    if (status === 'progress' || status === 'started') {
      this.history.splice(
        0,
        this.history.length,
        ...this.history.filter((record) => record.status !== 'progress'),
        event,
      );
    } else {
      this.history.push(event);
    }
    if (terminal) {
      this.terminal = true;
    }
    return event;
  }
  private nextStageElapsed(phase: string, elapsedMs: number) {
    return Math.max(this.phaseElapsed.get(phase) ?? 0, Math.max(0, elapsedMs));
  }
}
