// oxlint-disable curly -- compact NDJSON parser branches stay bounded and explicit

export const PNPM_PROGRESS_SCHEMA = 'revo-pnpm-progress/v1' as const;

export type PnpmProgressStatus = 'started' | 'progress' | 'completed' | 'failed';
export interface PnpmProgressEvent {
  readonly schemaVersion: typeof PNPM_PROGRESS_SCHEMA;
  readonly stage: string;
  readonly status: PnpmProgressStatus;
  readonly elapsedMs: number;
  readonly resolved?: number;
  readonly downloaded?: number;
  readonly reused?: number;
  readonly added?: number;
  readonly total?: number;
  readonly activity?: string;
}
export interface PnpmProgressParserOptions {
  readonly maxLineBytes?: number;
  readonly now?: () => number;
  readonly onRaw?: (line: string, reason: string) => void;
}
export interface PnpmProgressSink {
  readonly feed: (chunk: Uint8Array | string) => void;
  readonly finish: (result?: {
    readonly exitCode: number | null;
    readonly signal: string | null;
  }) => void;
}

const DEFAULT_MAX_LINE_BYTES = 128 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 512;
const elapsed = (time: unknown, first: number, previous: number, now: () => number): number => {
  const current = number(time) ? time : now();
  return Math.max(previous, Math.max(0, current - first));
};

export class PnpmProgressParser {
  private readonly decoder = new TextDecoder();
  private readonly now: () => number;
  private readonly limit: number;
  private readonly onRaw?: (line: string, reason: string) => void;
  private buffer = '';
  private firstTime: number | undefined;
  private lastElapsed = 0;
  private readonly seen = new Set<string>();
  private resolved = 0;
  private downloaded = 0;
  private reused = 0;
  private added = 0;
  private total: number | undefined;

  constructor(options: PnpmProgressParserOptions = {}) {
    this.limit = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.now = options.now ?? Date.now;
    if (options.onRaw !== undefined) this.onRaw = options.onRaw;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1)
      throw new Error('pnpm progress bound is invalid');
  }

  feed(chunk: Uint8Array | string): readonly PnpmProgressEvent[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const events: PnpmProgressEvent[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '');
      this.buffer = this.buffer.slice(newline + 1);
      events.push(...this.parseLine(line));
      newline = this.buffer.indexOf('\n');
    }
    if (new TextEncoder().encode(this.buffer).byteLength > this.limit) {
      this.onRaw?.(this.buffer.slice(0, this.limit), 'oversized');
      this.buffer = '';
    }
    return events;
  }

  finish(): readonly PnpmProgressEvent[] {
    const tail = this.decoder.decode();
    this.buffer += tail;
    if (!this.buffer) return [];
    const line = this.buffer.replace(/\r$/u, '');
    this.buffer = '';
    return this.parseLine(line);
  }

  private parseLine(line: string): readonly PnpmProgressEvent[] {
    if (!line) return [];
    if (new TextEncoder().encode(line).byteLength > this.limit) {
      this.onRaw?.(line.slice(0, this.limit), 'oversized');
      return [];
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.onRaw?.(line, 'malformed');
      return [];
    }
    if (!object(value) || !text(value.name)) {
      this.onRaw?.(line, 'unknown');
      return [];
    }
    const time = value.time;
    this.firstTime ??= number(time) ? time : this.now();
    const at = elapsed(time, this.firstTime, this.lastElapsed, this.now);
    this.lastElapsed = at;
    const event = this.event(value, at);
    if (value.name === 'pnpm' || event === undefined) this.onRaw?.(line, 'unknown');
    return event ? [event] : [];
  }

  private event(value: Record<string, unknown>, at: number): PnpmProgressEvent | null | undefined {
    if (number(value.total)) this.total = value.total;
    const name = value.name;
    if (name === 'pnpm:stage' && text(value.stage)) return this.stage(value.stage, at);
    if (name === 'pnpm:progress' && text(value.status))
      return this.progress(value, value.status, at);
    if (name === 'pnpm:root' && object(value.added)) return this.root(value.added, at);
    if (name === 'pnpm:execution-time') return this.make('install', 'completed', at);
    if (name === 'pnpm' && text(value.message)) return this.unknown(value, at);
    return undefined;
  }

  private stage(value: string, at: number): PnpmProgressEvent {
    let status: PnpmProgressStatus = 'progress';
    if (value.endsWith('_started')) status = 'started';
    else if (value.endsWith('_done')) status = 'completed';
    return this.make('install', status, at);
  }

  private progress(
    value: Record<string, unknown>,
    status: string,
    at: number,
  ): PnpmProgressEvent | null {
    if (!['resolved', 'fetched', 'found_in_store', 'imported'].includes(status))
      return this.unknown(value, at);
    const packageId = text(value.packageId) ? value.packageId : '';
    const key = `${status}:${packageId || JSON.stringify(value)}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    if (status === 'resolved') this.resolved += 1;
    if (status === 'fetched') this.downloaded += 1;
    if (status === 'found_in_store') this.reused += 1;
    return this.make('install', 'progress', at, status);
  }

  private root(item: Record<string, unknown>, at: number): PnpmProgressEvent | null {
    const key = `added:${text(item.name) ? item.name : JSON.stringify(item)}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    this.added += 1;
    return this.make('install', 'progress', at, 'added');
  }

  private unknown(_value: Record<string, unknown>, at: number): PnpmProgressEvent {
    return this.make('install', 'progress', at, 'activity');
  }

  private make(
    stage: string,
    status: PnpmProgressStatus,
    at: number,
    activity?: string,
  ): PnpmProgressEvent {
    const event: PnpmProgressEvent = {
      schemaVersion: PNPM_PROGRESS_SCHEMA,
      stage,
      status,
      elapsedMs: at,
      ...(this.resolved ? { resolved: this.resolved } : {}),
      ...(this.downloaded ? { downloaded: this.downloaded } : {}),
      ...(this.reused ? { reused: this.reused } : {}),
      ...(this.added ? { added: this.added } : {}),
      ...(this.total === undefined ? {} : { total: this.total }),
      ...(activity === undefined ? {} : { activity }),
    };
    return Object.freeze(event);
  }
}

export const createPnpmProgressParser = (options?: PnpmProgressParserOptions): PnpmProgressParser =>
  new PnpmProgressParser(options);

export function createPnpmProgressSink(
  options: {
    readonly onEvent?: (event: PnpmProgressEvent) => void;
    readonly onRaw?: (line: string, reason: string) => void;
    readonly parser?: PnpmProgressParser;
  } = {},
): PnpmProgressSink {
  const parser =
    options.parser ??
    new PnpmProgressParser(options.onRaw === undefined ? {} : { onRaw: options.onRaw });
  let lastElapsed = 0;
  const emit = (events: readonly PnpmProgressEvent[]) =>
    events.forEach((event) => {
      lastElapsed = event.elapsedMs;
      options.onEvent?.(event);
    });
  return {
    feed: (chunk) => emit(parser.feed(chunk)),
    finish: (result) => {
      emit(parser.finish());
      if (result && (result.exitCode !== 0 || result.signal !== null))
        options.onEvent?.({
          schemaVersion: PNPM_PROGRESS_SCHEMA,
          stage: 'install',
          status: 'failed',
          elapsedMs: lastElapsed,
          activity: `pnpm exited with ${result.exitCode ?? result.signal}`,
        });
    },
  };
}
