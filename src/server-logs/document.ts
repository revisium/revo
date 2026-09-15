import {
  MAX_SERVER_LIFECYCLE_DOCUMENT_BYTES,
  MAX_SERVER_LIFECYCLE_EVENT_BYTES,
  SERVER_LIFECYCLE_CORE_PHASES,
  SERVER_LIFECYCLE_READER_BYTES,
  SERVER_LIFECYCLE_SCHEMA_VERSION,
  type ServerLifecycleCode,
  type ServerLifecycleDocument,
  type ServerLifecycleEvent,
  type ServerLifecyclePhase,
  type ServerLifecycleState,
} from './server-lifecycle.types.js';

const EVENT_FIELDS = ['code', 'phase', 'sequence', 'state', 'time'] as const;
const DOCUMENT_FIELDS = ['events', 'schemaVersion'] as const;
const SERVER_CODES = new Map<string, readonly [ServerLifecyclePhase, ServerLifecycleState]>([
  ['SERVER_STARTING', ['server', 'starting']],
  ['SERVER_READY', ['server', 'ready']],
  ['SERVER_CANCELLED', ['server', 'cancelled']],
  ['SERVER_CORE_FAILED', ['server', 'failed']],
  ['SERVER_READINESS_FAILED', ['server', 'failed']],
  ['SERVER_START_FAILED', ['server', 'failed']],
  ['SERVER_STOPPING', ['shutdown', 'stopping']],
  ['SERVER_STOP_FAILED', ['shutdown', 'failed']],
  ['SERVER_RESOURCES_STOPPED', ['shutdown', 'stopped']],
  ['DATABASE_STARTING', ['postgres', 'starting']],
  ['DATABASE_READY', ['postgres', 'ready']],
  ['DATABASE_FAILED', ['postgres', 'failed']],
]);
const LIFECYCLE_CODES = new Set<string>([
  ...SERVER_CODES.keys(),
  'CORE_STAGE_STARTED',
  'CORE_STAGE_COMPLETED',
  'CORE_STAGE_FAILED',
]);
const CORE_PHASES = new Set<string>(SERVER_LIFECYCLE_CORE_PHASES);
export function lifecycleCodeFacts(
  code: string,
  corePhase?: ServerLifecyclePhase,
): { readonly phase: ServerLifecyclePhase; readonly state: ServerLifecycleState } | undefined {
  if (
    code === 'CORE_STAGE_STARTED' ||
    code === 'CORE_STAGE_COMPLETED' ||
    code === 'CORE_STAGE_FAILED'
  ) {
    if (!corePhase || !isCorePhase(corePhase)) {
      return undefined;
    }
    if (code === 'CORE_STAGE_STARTED') {
      return { phase: corePhase, state: 'started' };
    }
    if (code === 'CORE_STAGE_COMPLETED') {
      return { phase: corePhase, state: 'completed' };
    }
    return { phase: corePhase, state: 'failed' };
  }
  const facts = SERVER_CODES.get(code);
  return facts ? { phase: facts[0], state: facts[1] } : undefined;
}

export function createLifecycleEvent(
  sequence: number,
  time: number,
  code: ServerLifecycleCode,
  corePhase?: ServerLifecyclePhase,
): ServerLifecycleEvent | undefined {
  const facts = lifecycleCodeFacts(code, corePhase);
  const event = facts && { sequence, time, phase: facts.phase, state: facts.state, code };
  return validLifecycleEvent(event) ? event : undefined;
}

export function validLifecycleEvent(value: unknown): value is ServerLifecycleEvent {
  const candidate = record(value) && exactKeys(value, EVENT_FIELDS) ? value : undefined;
  if (!candidate) {
    return false;
  }
  const { sequence, time, phase, state, code } = candidate;
  if (
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    typeof time !== 'number' ||
    !Number.isSafeInteger(time) ||
    time < 0 ||
    typeof phase !== 'string' ||
    typeof state !== 'string' ||
    typeof code !== 'string' ||
    !LIFECYCLE_CODES.has(code) ||
    !isLifecyclePhase(phase)
  ) {
    return false;
  }
  const facts = lifecycleCodeFacts(code, phase);
  return (
    facts?.phase === phase &&
    facts?.state === state &&
    eventBytes(value) <= MAX_SERVER_LIFECYCLE_EVENT_BYTES
  );
}

export function parseLifecycleDocument(value: unknown): ServerLifecycleDocument | undefined {
  let candidate = value;
  if (typeof value === 'string') {
    try {
      candidate =
        Buffer.byteLength(value, 'utf8') <= SERVER_LIFECYCLE_READER_BYTES
          ? JSON.parse(value)
          : undefined;
    } catch {
      return undefined;
    }
  }
  if (
    !record(candidate) ||
    !exactKeys(candidate, DOCUMENT_FIELDS) ||
    candidate.schemaVersion !== SERVER_LIFECYCLE_SCHEMA_VERSION ||
    !Array.isArray(candidate.events) ||
    candidate.events.length > 128
  ) {
    return undefined;
  }
  const events: ServerLifecycleEvent[] = [];
  let previous: number | undefined;
  for (const candidateEvent of candidate.events) {
    if (
      !validLifecycleEvent(candidateEvent) ||
      (previous !== undefined && candidateEvent.sequence !== previous + 1)
    ) {
      return undefined;
    }
    events.push(candidateEvent);
    previous = candidateEvent.sequence;
  }
  const document = { schemaVersion: SERVER_LIFECYCLE_SCHEMA_VERSION, events };
  return documentBytes(document) <= MAX_SERVER_LIFECYCLE_DOCUMENT_BYTES ? document : undefined;
}

export function serializeLifecycleDocument(events: readonly ServerLifecycleEvent[]): string {
  let previous: number | undefined;
  if (events.length > 128 || !events.every(validLifecycleEvent)) {
    throw new Error('Invalid server lifecycle document');
  }
  for (const event of events) {
    if (previous !== undefined && event.sequence !== previous + 1) {
      throw new Error('Invalid server lifecycle document');
    }
    previous = event.sequence;
  }
  const document = { schemaVersion: SERVER_LIFECYCLE_SCHEMA_VERSION, events };
  const serialized = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERVER_LIFECYCLE_DOCUMENT_BYTES) {
    throw new Error('Invalid server lifecycle document');
  }
  return serialized;
}

function eventBytes(event: unknown): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}

function documentBytes(document: ServerLifecycleDocument): number {
  return Buffer.byteLength(`${JSON.stringify(document)}\n`, 'utf8');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isCorePhase(value: string): value is (typeof SERVER_LIFECYCLE_CORE_PHASES)[number] {
  return CORE_PHASES.has(value);
}

function isLifecyclePhase(value: string): value is ServerLifecyclePhase {
  return value === 'server' || value === 'postgres' || value === 'shutdown' || isCorePhase(value);
}
