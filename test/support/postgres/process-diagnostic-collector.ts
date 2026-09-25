import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import type {
  ManagedProcessRequest,
  OwnedProcess,
  ProcessCancellationResult,
  ProcessCompletion,
  StopProcessRequest,
} from '../../../src/processes/managed-process.types.js';

const MAX_PROCESS_STDERR_BYTES = 16 * 1024;
const MAX_PROCESS_STDOUT_BYTES = 16 * 1024;
const MAX_REPORT_BYTES = 128 * 1024;
const MAX_TRACE_EVENTS = 256;
const MAX_FIELD_LENGTH = 1024;

type TraceValue = string | number | boolean | null | readonly TraceValue[];
type TraceFields = Readonly<Record<string, TraceValue>>;

interface ProcessDiagnostics {
  readonly id: number;
  readonly owner: string;
  readonly role: 'initdb' | 'postgres' | 'unknown';
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly dataDirectory: string;
  readonly detached: boolean;
  readonly stdio: ManagedProcessRequest['stdio'];
  readonly cancellation: {
    readonly graceMs: number;
    readonly killWaitMs: number;
    readonly signalAbortedAtStart: boolean;
  } | null;
  readonly startedAtMs: number;
  completion?: ProcessCompletion;
  completedAtMs?: number;
  cancellationResult?: ProcessCancellationResult['kind'];
  stderrTail: Buffer;
  stderrBytes: number;
  stderrDiscardedBytes: number;
  stderrLastOutputAtMs?: number;
  stderrEnded: boolean;
  stderrClosed: boolean;
  stderrError?: string;
  stderrCaptureIncomplete: boolean;
  stdoutTail: Buffer;
  stdoutBytes: number;
  stdoutDiscardedBytes: number;
  stdoutLastOutputAtMs?: number;
  stdoutEnded: boolean;
  stdoutClosed: boolean;
  stdoutError?: string;
  stdoutCaptureIncomplete: boolean;
}

interface TraceEvent {
  readonly atMs: number;
  readonly event: string;
  readonly owner?: string;
  readonly processId?: number;
  readonly fields?: TraceFields;
}

export interface DiagnosticProcessRequest {
  readonly owner: string;
  readonly request: ManagedProcessRequest;
}

export class PostgresProcessDiagnosticCollector {
  private readonly origin = performance.now();
  private readonly dataDirectory: string;
  private readonly processes = new Map<number, ProcessDiagnostics>();
  private readonly abortListeners = new Map<number, () => void>();
  private readonly abortSignals = new Map<number, AbortSignal>();
  private readonly events: TraceEvent[] = [];
  private readonly outputDrains: Promise<void>[] = [];
  private nextProcessId = 0;
  private droppedEvents = 0;
  private collectorErrors = 0;

  constructor(dataDirectory: string) {
    this.dataDirectory = resolve(dataDirectory);
  }

  scenario(event: string, fields: TraceFields = {}) {
    this.record(event, fields);
  }

  startRequested({ owner, request }: DiagnosticProcessRequest): number {
    const id = ++this.nextProcessId;
    const executable = basename(request.executable);
    const role = processRole(executable);
    const cancellation = request.cancellation;
    const item: ProcessDiagnostics = {
      id,
      owner,
      role,
      executable: safeText(executable, this.dataDirectory),
      args: request.args.slice(0, 32).map((argument) => safeText(argument, this.dataDirectory)),
      cwd: safePath(request.cwd, this.dataDirectory),
      dataDirectory: safePath(extractDataDirectory(request), this.dataDirectory),
      detached: request.detached === true,
      stdio: request.stdio,
      cancellation:
        cancellation === undefined
          ? null
          : {
              graceMs: cancellation.graceMs,
              killWaitMs: cancellation.killWaitMs,
              signalAbortedAtStart: cancellation.signal.aborted,
            },
      startedAtMs: this.elapsed(),
      stderrTail: Buffer.alloc(0),
      stderrBytes: 0,
      stderrDiscardedBytes: 0,
      stderrEnded: false,
      stderrClosed: false,
      stderrCaptureIncomplete: request.stdio.stderr !== 'pipe',
      stdoutTail: Buffer.alloc(0),
      stdoutBytes: 0,
      stdoutDiscardedBytes: 0,
      stdoutEnded: false,
      stdoutClosed: false,
      stdoutCaptureIncomplete: request.stdio.stdout !== 'pipe',
    };
    this.processes.set(id, item);
    this.record('process-start-requested', {
      owner,
      processId: id,
      role,
      executable: item.executable,
      args: item.args,
      cwd: item.cwd,
      dataDirectory: item.dataDirectory,
      detached: item.detached,
      stdio: `${request.stdio.stdin}/${request.stdio.stdout}/${request.stdio.stderr}`,
      cancellation: cancellation
        ? `grace=${cancellation.graceMs};killWait=${cancellation.killWaitMs};alreadyAborted=${cancellation.signal.aborted}`
        : 'none',
    });
    if (cancellation !== undefined) {
      const abortListener = () =>
        this.record('process-cancellation-signal', { owner, processId: id });
      this.abortListeners.set(id, abortListener);
      this.abortSignals.set(id, cancellation.signal);
      cancellation.signal.addEventListener('abort', abortListener, { once: true });
      if (cancellation.signal.aborted) {
        abortListener();
      }
    }
    return id;
  }

  startRejected(id: number, error: unknown) {
    const item = this.processes.get(id);
    this.record('process-start-rejected', {
      owner: item?.owner ?? 'unknown',
      processId: id,
      error: safeError(error, this.dataDirectory),
    });
    this.detachAbortListener(id);
  }

  processStarted(id: number, handle: OwnedProcess) {
    const item = this.processes.get(id);
    if (!item) {
      return;
    }
    this.record('process-spawned', { owner: item.owner, processId: id });
    if (handle.stdout) {
      this.observeOutput(id, handle.stdout, 'stdout');
    } else {
      item.stdoutCaptureIncomplete = true;
    }
    if (handle.stderr) {
      this.observeOutput(id, handle.stderr, 'stderr');
    } else {
      item.stderrCaptureIncomplete = true;
    }
    void handle.completion.then(
      (completion) => {
        item.completion = completion;
        item.completedAtMs = this.elapsed();
        this.record('process-completed', {
          owner: item.owner,
          processId: id,
          exitCode: completion.exitCode,
          signal: completion.signal,
          elapsedMs: item.completedAtMs - item.startedAtMs,
        });
        this.detachAbortListener(id);
      },
      (error: unknown) => {
        item.completedAtMs = this.elapsed();
        item.stderrCaptureIncomplete = true;
        this.record('process-completion-rejected', {
          owner: item.owner,
          processId: id,
          error: safeError(error, this.dataDirectory),
        });
        this.detachAbortListener(id);
      },
    );
    if (handle.cancellationResult) {
      void handle.cancellationResult.then(
        (result) => {
          item.cancellationResult = result.kind;
          this.record('process-cancellation-result', {
            owner: item.owner,
            processId: id,
            result: result.kind,
          });
        },
        (error: unknown) => {
          item.cancellationResult = 'failed';
          this.record('process-cancellation-result-rejected', {
            owner: item.owner,
            processId: id,
            error: safeError(error, this.dataDirectory),
          });
        },
      );
    }
  }

  stopRequested(id: number | undefined, request: StopProcessRequest) {
    const item = id === undefined ? undefined : this.processes.get(id);
    this.record('process-stop-requested', {
      ...(item ? { owner: item.owner, processId: item.id } : {}),
      graceMs: request.graceMs,
      killWaitMs: request.killWaitMs,
    });
  }

  stopResolved(id: number | undefined) {
    const item = id === undefined ? undefined : this.processes.get(id);
    this.record('process-stop-resolved', {
      ...(item ? { owner: item.owner, processId: item.id } : {}),
    });
  }

  stopRejected(id: number | undefined, error: unknown) {
    const item = id === undefined ? undefined : this.processes.get(id);
    this.record('process-stop-rejected', {
      ...(item ? { owner: item.owner, processId: item.id } : {}),
      error: safeError(error, this.dataDirectory),
    });
  }

  async waitForStderr(timeoutMs: number) {
    if (this.outputDrains.length === 0) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, timeoutMs);
    });
    await Promise.race([Promise.all(this.outputDrains), timeout]);
    if (timer) {
      clearTimeout(timer);
    }
    for (const item of this.processes.values()) {
      if (!item.stderrEnded && !item.stderrClosed) {
        item.stderrCaptureIncomplete = true;
      }
      if (!item.stdoutEnded && !item.stdoutClosed) {
        item.stdoutCaptureIncomplete = true;
      }
    }
  }

  formatReport(phase: string, error?: unknown): string {
    const processSnapshots = [...this.processes.values()].map(
      ({ stderrTail, stdoutTail, ...item }) => ({
        ...item,
        stderr: sanitizeText(stderrTail.toString('utf8'), this.dataDirectory),
        stdout: sanitizeText(stdoutTail.toString('utf8'), this.dataDirectory),
      }),
    );
    const report = {
      schema: 'revo-postgres-lifecycle-diagnostic/v1',
      phase: safeText(phase, this.dataDirectory),
      error: error === undefined ? null : safeError(error, this.dataDirectory),
      elapsedMs: this.elapsed(),
      droppedEvents: this.droppedEvents,
      collectorErrors: this.collectorErrors,
      processes: processSnapshots,
      events: [...this.events],
    };
    let line = JSON.stringify(report);
    while (Buffer.byteLength(line) > MAX_REPORT_BYTES) {
      const largestSnapshot = [...processSnapshots].sort(
        (left, right) =>
          Math.max(Buffer.byteLength(right.stderr), Buffer.byteLength(right.stdout)) -
          Math.max(Buffer.byteLength(left.stderr), Buffer.byteLength(left.stdout)),
      )[0];
      if (
        largestSnapshot &&
        Buffer.byteLength(largestSnapshot.stderr) >= Buffer.byteLength(largestSnapshot.stdout) &&
        Buffer.byteLength(largestSnapshot.stderr) > 0
      ) {
        const nextLimit = Math.floor(Buffer.byteLength(largestSnapshot.stderr) / 2);
        largestSnapshot.stderr = trimUtf8Tail(largestSnapshot.stderr, nextLimit);
        largestSnapshot.stderrCaptureIncomplete = true;
      } else if (largestSnapshot && Buffer.byteLength(largestSnapshot.stdout) > 0) {
        const nextLimit = Math.floor(Buffer.byteLength(largestSnapshot.stdout) / 2);
        largestSnapshot.stdout = trimUtf8Tail(largestSnapshot.stdout, nextLimit);
        largestSnapshot.stdoutCaptureIncomplete = true;
      } else if (this.events.length > 16) {
        this.events.splice(Math.floor(this.events.length / 2), 1);
        this.droppedEvents += 1;
      } else {
        this.collectorErrors += 1;
        break;
      }
      report.droppedEvents = this.droppedEvents;
      report.collectorErrors = this.collectorErrors;
      report.processes = processSnapshots;
      report.events = [...this.events];
      line = JSON.stringify(report);
    }
    return `POSTGRES_LIFECYCLE_DIAGNOSTICS ${line}`;
  }

  private observeOutput(id: number, stream: Readable, kind: 'stdout' | 'stderr') {
    const item = this.processes.get(id);
    if (!item) {
      return;
    }
    const decoder = new StringDecoder('utf8');
    let settleDrain: (() => void) | undefined;
    const drain = new Promise<void>((resolveDrain) => {
      settleDrain = resolveDrain;
    });
    this.outputDrains.push(drain);
    let drainSettled = false;
    const settle = () => {
      if (drainSettled) {
        return;
      }
      drainSettled = true;
      settleDrain?.();
    };
    const append = (text: string, receivedBytes: number) => {
      if (receivedBytes === 0 && text.length === 0) {
        return;
      }
      const limit = kind === 'stderr' ? MAX_PROCESS_STDERR_BYTES : MAX_PROCESS_STDOUT_BYTES;
      const receivedAtMs = this.elapsed();
      if (kind === 'stderr') {
        item.stderrBytes += receivedBytes;
        item.stderrLastOutputAtMs = receivedAtMs;
      } else {
        item.stdoutBytes += receivedBytes;
        item.stdoutLastOutputAtMs = receivedAtMs;
      }
      const previous = kind === 'stderr' ? item.stderrTail : item.stdoutTail;
      const combined = Buffer.concat([previous, Buffer.from(text)]);
      const discarded = Math.max(0, combined.length - limit);
      const tail =
        discarded > 0 ? Buffer.from(trimUtf8Tail(combined.toString('utf8'), limit)) : combined;
      if (kind === 'stderr') {
        item.stderrDiscardedBytes += discarded;
        item.stderrTail = tail;
      } else {
        item.stdoutDiscardedBytes += discarded;
        item.stdoutTail = tail;
      }
    };
    stream.on('data', (chunk: unknown) => {
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        append(decoder.write(buffer), buffer.length);
      } catch {
        this.collectorErrors += 1;
        if (kind === 'stderr') {
          item.stderrCaptureIncomplete = true;
        } else {
          item.stdoutCaptureIncomplete = true;
        }
      }
    });
    stream.once('end', () => {
      try {
        append(decoder.end(), 0);
        if (kind === 'stderr') {
          item.stderrEnded = true;
        } else {
          item.stdoutEnded = true;
        }
      } catch {
        this.collectorErrors += 1;
        if (kind === 'stderr') {
          item.stderrCaptureIncomplete = true;
        } else {
          item.stdoutCaptureIncomplete = true;
        }
      } finally {
        settle();
      }
    });
    stream.once('close', () => {
      if (kind === 'stderr') {
        item.stderrClosed = true;
        if (!item.stderrEnded) {
          item.stderrCaptureIncomplete = true;
        }
      } else {
        item.stdoutClosed = true;
        if (!item.stdoutEnded) {
          item.stdoutCaptureIncomplete = true;
        }
      }
      settle();
    });
    stream.once('error', (error: unknown) => {
      if (kind === 'stderr') {
        item.stderrError = safeError(error, this.dataDirectory);
        item.stderrCaptureIncomplete = true;
      } else {
        item.stdoutError = safeError(error, this.dataDirectory);
        item.stdoutCaptureIncomplete = true;
      }
      settle();
    });
  }

  private record(event: string, fields: TraceFields = {}) {
    if (this.events.length >= MAX_TRACE_EVENTS) {
      this.droppedEvents += 1;
      return;
    }
    try {
      const safeFields = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          safeText(key, this.dataDirectory),
          safeTraceValue(value, this.dataDirectory),
        ]),
      ) as TraceFields;
      this.events.push({
        atMs: this.elapsed(),
        event: safeText(event, this.dataDirectory),
        ...safeFields,
      });
    } catch {
      this.collectorErrors += 1;
    }
  }

  private elapsed() {
    return Math.max(0, Math.round(performance.now() - this.origin));
  }

  private detachAbortListener(id: number) {
    const listener = this.abortListeners.get(id);
    const signal = this.abortSignals.get(id);
    if (listener && signal) {
      signal.removeEventListener('abort', listener);
      this.abortListeners.delete(id);
      this.abortSignals.delete(id);
    }
  }
}

function processRole(executable: string): ProcessDiagnostics['role'] {
  const name = executable.toLowerCase();
  if (name === 'initdb' || name.startsWith('initdb.')) {
    return 'initdb';
  }
  if (name === 'postgres' || name.startsWith('postgres.')) {
    return 'postgres';
  }
  return 'unknown';
}

function extractDataDirectory(request: ManagedProcessRequest): string {
  const index = request.args.indexOf('-D');
  return index >= 0 ? (request.args[index + 1] ?? request.cwd) : request.cwd;
}

function safePath(value: string, dataDirectory: string): string {
  return safeText(resolve(value), dataDirectory);
}

function safeError(error: unknown, dataDirectory: string): string {
  let message = 'unknown';
  if (error instanceof Error) {
    message = `${error.name}: ${error.message}`;
  } else if (typeof error === 'string') {
    message = error;
  } else if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    message = error.message;
  } else if (error !== null && error !== undefined) {
    message = `non-error ${typeof error}`;
  }
  return safeText(message, dataDirectory);
}

function safeText(value: string, dataDirectory: string): string {
  const result = sanitizeText(value, dataDirectory);
  if (result.length > MAX_FIELD_LENGTH) {
    return `${result.slice(-MAX_FIELD_LENGTH)}<truncated>`;
  }
  return result;
}

function sanitizeText(value: string, dataDirectory: string): string {
  // oxlint-disable-next-line no-control-regex -- Strip ANSI terminal escapes from captured child output.
  let result = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
  result = result.replaceAll(dataDirectory, '<data-dir>');
  result = result.replace(/\b(postgres(?:ql)?:\/\/)[^\s/@]+@/giu, '$1<redacted>@');
  result = result.replace(
    /\b(password|passwd|token|secret|authorization|credential)\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    '$1$2<redacted>',
  );
  result = result.replace(/(cluster_name=revo-)[0-9a-f]{32}/giu, '$1<nonce>');
  result = result.replace(
    /(^|[\s"'(=])(?:[A-Za-z]:\\[^\s"'<>|]+|\/(?:[^/\s"'<>|]+\/?)+)/gu,
    '$1<path>',
  );
  return Array.from(result)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (codePoint >= 0x20 && codePoint !== 0x7f) || codePoint === 0x09 || codePoint === 0x0a;
    })
    .join('');
}

function safeTraceValue(value: TraceValue, dataDirectory: string): TraceValue {
  if (typeof value === 'string') {
    return safeText(value, dataDirectory);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => safeTraceValue(item, dataDirectory));
  }
  return value;
}

function trimUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  const buffer = Buffer.from(value);
  if (buffer.length <= maxBytes) {
    return value;
  }
  let tail = buffer.subarray(buffer.length - maxBytes).toString('utf8');
  if (tail.startsWith('\uFFFD')) {
    tail = tail.slice(1);
  }
  return tail;
}
