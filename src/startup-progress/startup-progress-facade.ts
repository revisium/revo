import {
  PROGRESS_SCHEMA_VERSION,
  ProgressOperation,
  type ProgressCounters,
  type ProgressEvent,
} from '../progress/index.js';
import { StartupProgressJournalWriter } from './startup-progress-journal.service.js';
import {
  TERMINAL_PROGRESS_RESERVE_BYTES,
  StartupProgressError,
  type StartupProgressFacade,
  type StartupProgressOptions,
  type StartupReadyContext,
} from './startup-progress.types.js';

export class OwnedStartupProgress implements StartupProgressFacade {
  private readonly operation: ProgressOperation;
  private queue = Promise.resolve();
  private closed = false;
  private disabled = false;
  private lastPersistedSequence = 0;
  private readonly operationId: string;
  private readonly origin: number;
  private readonly now: () => number;
  private sampledNow: number | undefined;

  constructor(
    private readonly journal: StartupProgressJournalWriter,
    private readonly canonicalDataDir: string,
    options: StartupProgressOptions,
  ) {
    this.operationId = options.operationId;
    this.now = options.now;
    this.origin = options.now();
    this.operation = new ProgressOperation({
      operationId: options.operationId,
      now: () => this.sampledNow ?? this.origin,
    });
  }

  initialize() {
    return this.journal.write(this.canonicalDataDir, this.operationId, []);
  }
  start(phase: string) {
    return this.enqueue(() => this.operation.start(phase));
  }
  progress(
    phase: string,
    details: { readonly counters?: ProgressCounters; readonly stageElapsedMs?: number } = {},
  ) {
    return this.enqueue(() => this.operation.progress(phase, details));
  }
  complete(phase: string) {
    return this.enqueue(() => this.operation.complete(phase));
  }
  fail(phase: string, details: { readonly code: string; readonly logPath?: string }) {
    return this.enqueueTerminal(phase, 'failed', details, () =>
      this.operation.fail(phase, details),
    );
  }
  ready(details: { readonly url: string; readonly reused?: true }, context?: StartupReadyContext) {
    return this.enqueueTerminal(
      'server-start',
      'ready',
      details,
      () => this.operation.ready(details),
      context,
    );
  }
  close(): Promise<void> {
    this.seal();
    return this.queue;
  }

  seal(): void {
    this.closed = true;
  }

  private enqueue(
    create: () => ProgressEvent | undefined,
    context?: StartupReadyContext,
  ): Promise<ProgressEvent> {
    if (this.closed || this.disabled) {
      return Promise.reject(new StartupProgressError('closed'));
    }
    const operation = this.queue.then(async () => {
      if (this.disabled) {
        throw new StartupProgressError('closed');
      }
      this.sampledNow = this.now();
      let event: ProgressEvent | undefined;
      try {
        event = create();
      } finally {
        this.sampledNow = undefined;
      }
      if (!event) {
        throw new StartupProgressError('closed');
      }
      try {
        await this.persist(context);
        this.lastPersistedSequence = event.sequence;
        return event;
      } catch (error) {
        this.disabled = true;
        if (
          error instanceof StartupProgressError &&
          error.reason === 'limit' &&
          event.status !== 'failed' &&
          event.status !== 'ready'
        ) {
          const failure = this.operation.fail(event.phase, { code: 'PROGRESS_JOURNAL_LIMIT' });
          if (failure) {
            const retained = this.operation
              .eventsAfter(0)
              .filter(
                (record) =>
                  record.sequence <= this.lastPersistedSequence ||
                  record.sequence === failure.sequence,
              );
            await this.journal.write(this.canonicalDataDir, this.operationId, retained);
          }
        }
        throw error instanceof StartupProgressError ? error : new StartupProgressError('io');
      }
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private enqueueTerminal(
    phase: string,
    status: 'failed' | 'ready',
    details: object,
    create: () => ProgressEvent | undefined,
    context?: StartupReadyContext,
  ) {
    return this.enqueue(() => {
      const previous = this.operation.eventsAfter(0).at(-1);
      const envelope = {
        schemaVersion: PROGRESS_SCHEMA_VERSION,
        operationId: this.operationId,
        sequence: (previous?.sequence ?? 0) + 1,
        phase,
        status,
        elapsedMs: Math.max(
          previous?.elapsedMs ?? 0,
          Math.max(0, (this.sampledNow ?? this.origin) - this.origin),
        ),
        ...details,
      };
      if (Buffer.byteLength(`${JSON.stringify(envelope)}\n`) > TERMINAL_PROGRESS_RESERVE_BYTES) {
        return this.operation.fail(phase, { code: 'PROGRESS_JOURNAL_LIMIT' });
      }
      return create();
    }, context).then((event) => {
      if (event.status === 'failed' && event.code === 'PROGRESS_JOURNAL_LIMIT') {
        this.disabled = true;
        throw new StartupProgressError('limit');
      }
      return event;
    });
  }
  private persist(context?: StartupReadyContext) {
    return this.journal.write(
      this.canonicalDataDir,
      this.operationId,
      this.operation.eventsAfter(0),
      context,
    );
  }
}
