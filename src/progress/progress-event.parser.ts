import {
  PROGRESS_SCHEMA_VERSION,
  type ProgressCounters,
  type ProgressEvent,
  type ProgressStatus,
} from './progress-event.js';

const OPERATION_ID = /^[0-9a-f]{32}$/u;
const PHASE = /^[a-z][a-z0-9-]{0,63}$/u;
const COUNTERS = [
  'bytesReceived',
  'bytesTotal',
  'pnpmResolved',
  'pnpmReused',
  'pnpmDownloaded',
  'pnpmAdded',
] as const;
const OPTIONAL = ['counters', 'stageElapsedMs', 'code', 'logPath', 'url', 'reused'] as const;
const BASE = ['schemaVersion', 'operationId', 'sequence', 'phase', 'status', 'elapsedMs'] as const;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const exactKnown = (value: Record<string, unknown>, known: readonly string[]) =>
  Object.keys(value).every((key) => known.includes(key));

export function parseProgressEvent(value: unknown): ProgressEvent | undefined {
  if (!record(value) || !BASE.every((key) => Object.hasOwn(value, key))) {
    return undefined;
  }
  if (!exactKnown(value, [...BASE, ...OPTIONAL])) {
    return undefined;
  }
  if (
    value.schemaVersion !== PROGRESS_SCHEMA_VERSION ||
    typeof value.operationId !== 'string' ||
    !OPERATION_ID.test(value.operationId) ||
    typeof value.sequence !== 'number' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !isPhase(value.phase) ||
    !isStatus(value.status) ||
    !nonnegative(value.elapsedMs)
  ) {
    return undefined;
  }
  const counters = parseCounters(value.counters);
  if (value.counters !== undefined && !counters) {
    return undefined;
  }
  if (value.stageElapsedMs !== undefined && !nonnegative(value.stageElapsedMs)) {
    return undefined;
  }
  if (!validShape(value)) {
    return undefined;
  }
  return {
    schemaVersion: PROGRESS_SCHEMA_VERSION,
    operationId: value.operationId,
    sequence: value.sequence,
    phase: value.phase,
    status: value.status,
    elapsedMs: value.elapsedMs,
    ...(counters ? { counters } : {}),
    ...(typeof value.stageElapsedMs === 'number' ? { stageElapsedMs: value.stageElapsedMs } : {}),
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(typeof value.logPath === 'string' ? { logPath: value.logPath } : {}),
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
    ...(value.reused === true ? { reused: true as const } : {}),
  };
}

function parseCounters(value: unknown): ProgressCounters | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!record(value) || !exactKnown(value, COUNTERS) || Object.keys(value).length === 0) {
    return undefined;
  }
  if (
    !Object.values(value).every((counter) => nonnegative(counter) && Number.isSafeInteger(counter))
  ) {
    return undefined;
  }
  return Object.freeze({ ...value });
}
function validShape(value: Record<string, unknown>): boolean {
  if (value.status === 'progress') {
    return (
      value.code === undefined &&
      value.logPath === undefined &&
      value.url === undefined &&
      value.reused === undefined
    );
  }
  if (value.status === 'completed') {
    return (
      value.counters === undefined &&
      value.code === undefined &&
      value.logPath === undefined &&
      value.url === undefined &&
      value.reused === undefined
    );
  }
  if (value.status === 'failed') {
    return (
      typeof value.code === 'string' &&
      CODE.test(value.code) &&
      (value.logPath === undefined ||
        (typeof value.logPath === 'string' && safeText(value.logPath))) &&
      value.counters === undefined &&
      value.stageElapsedMs === undefined &&
      value.url === undefined &&
      value.reused === undefined
    );
  }
  if (value.status === 'ready') {
    return (
      value.phase === 'server-start' &&
      validOrigin(value.url) &&
      value.counters === undefined &&
      value.stageElapsedMs === undefined &&
      value.code === undefined &&
      value.logPath === undefined &&
      (value.reused === undefined || value.reused === true)
    );
  }
  return !OPTIONAL.some((key) => Object.hasOwn(value, key));
}
const isPhase = (value: unknown): value is string => typeof value === 'string' && PHASE.test(value);
const isStatus = (value: unknown): value is ProgressStatus =>
  value === 'started' ||
  value === 'progress' ||
  value === 'completed' ||
  value === 'failed' ||
  value === 'ready';

function validOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || !safeText(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.origin === value.replace(/\/$/u, '')
    );
  } catch {
    return false;
  }
}

function safeText(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) {
      return false;
    }
  }
  return true;
}
