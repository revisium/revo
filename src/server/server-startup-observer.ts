import process from 'node:process';

import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  PROGRESS_SCHEMA_VERSION,
  ProgressOperation,
  parseProgressEvent,
  type ProgressEvent,
} from '../progress/index.js';
import { StartupProgressDiscoveryService } from '../startup-progress/index.js';
import type { StartedServer } from './server-launch-attempt.js';

export type ServerProgressSink = (event: ProgressEvent) => void | Promise<void>;
export type StartupProgressWarning = (message: string) => void;

export interface StartupObserverTiming {
  readonly deliveryMs: number;
  readonly drainMs: number;
  readonly pollMs: number;
}

export const STARTUP_PROGRESS_WARNING = Symbol('STARTUP_PROGRESS_WARNING');
export const STARTUP_OBSERVER_TIMING = Symbol('STARTUP_OBSERVER_TIMING');

const DEFAULT_TIMING: StartupObserverTiming = { deliveryMs: 2_000, drainMs: 5_000, pollMs: 25 };
const SKIPPED = 'Warning: skipped startup progress because';
const WARNINGS = {
  journal: `${SKIPPED} the progress journal could not be read in time.`,
  output: `${SKIPPED} progress output could not be written in time.`,
  url: `${SKIPPED} the running server did not report its URL.`,
} as const;

type Settlement = 'fulfilled' | 'rejected' | 'timeout';

export class StartProgressOutputError extends Error {
  readonly code = 'START_PROGRESS_OUTPUT_FAILED';
  constructor() {
    super('Startup progress output failed.');
    this.name = 'StartProgressOutputError';
  }
}

interface Observation {
  readonly dataDir: string;
  readonly operationId: string;
  readonly deadline: number;
  readonly sink: ServerProgressSink;
}

@Injectable()
export class ServerStartupObserver {
  private readonly timing: StartupObserverTiming;

  constructor(
    @Inject(StartupProgressDiscoveryService)
    private readonly discovery: Pick<
      StartupProgressDiscoveryService,
      'read'
    > = new StartupProgressDiscoveryService(),
    @Optional()
    @Inject(STARTUP_PROGRESS_WARNING)
    private readonly warn: StartupProgressWarning = writeWarning,
    @Optional() @Inject(STARTUP_OBSERVER_TIMING) timing?: StartupObserverTiming,
  ) {
    this.timing = timing ?? DEFAULT_TIMING;
  }

  async observe(attempt: Promise<StartedServer>, options: Observation): Promise<StartedServer> {
    const delivery = new ProgressDelivery(options.sink, this.timing, new Warnings(this.warn));
    const journal = new JournalObservation(this.discovery, options, this.timing, delivery);
    // Attach both handlers immediately; observation never owns attempt cancellation or cleanup.
    const outcome = attempt.then(
      (value) => ({ kind: 'started' as const, value }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    );
    const following = journal.follow();
    const result = await outcome;
    await journal.drain(following);
    if (result.kind === 'failed') {
      await journal.reportFailure();
      throw result.error;
    }
    await journal.reportReady(result.value.url);
    return result.value;
  }

  async reused(
    url: string | undefined,
    sink: ServerProgressSink,
    operationId: string,
  ): Promise<void> {
    const warnings = new Warnings(this.warn);
    const event = url
      ? new ProgressOperation({ operationId, now: Date.now }).ready({ url, reused: true })
      : undefined;
    if (!event) {
      warnings.emit('url');
      return;
    }
    await new ProgressDelivery(sink, this.timing, warnings).final(event, Date.now());
  }
}

class Warnings {
  private readonly emitted = new Set<keyof typeof WARNINGS>();

  constructor(private readonly warn: StartupProgressWarning) {}

  emit(kind: keyof typeof WARNINGS): void {
    if (this.emitted.has(kind)) {
      return;
    }
    this.emitted.add(kind);
    try {
      this.warn(WARNINGS[kind]);
    } catch {
      // A warning is best effort, exactly like the progress it describes.
    }
  }
}

class ProgressDelivery {
  private inFlight: Promise<Settlement> | undefined;

  constructor(
    private readonly sink: ServerProgressSink,
    private readonly timing: StartupObserverTiming,
    readonly warnings: Warnings,
  ) {}

  async tick(event: ProgressEvent): Promise<void> {
    if (this.inFlight) {
      this.warnings.emit('output');
      return;
    }
    await this.write(event);
  }

  async final(event: ProgressEvent, drainStarted: number): Promise<void> {
    if (this.inFlight) {
      await settlesWithin(this.inFlight, drainStarted + this.timing.drainMs - Date.now());
    }
    await this.write(event);
  }

  private async write(event: ProgressEvent): Promise<void> {
    const write = Promise.resolve().then(() => this.sink(event));
    const settled = settlement(write);
    this.inFlight = settled;
    void settled.then(() => {
      if (this.inFlight === settled) {
        this.inFlight = undefined;
      }
    });
    if ((await settlesWithin(write, this.timing.deliveryMs)) !== 'fulfilled') {
      this.warnings.emit('output');
    }
  }
}

class JournalObservation {
  private cursor = 0;
  private elapsedMs = 0;
  private ready: ProgressEvent | undefined;
  private failure: ProgressEvent | undefined;
  private settled = false;
  private closed = false;
  private drainStarted = 0;
  private wake: (() => void) | undefined;
  private readonly started = Date.now();

  constructor(
    private readonly discovery: Pick<StartupProgressDiscoveryService, 'read'>,
    private readonly options: Observation,
    private readonly timing: StartupObserverTiming,
    private readonly delivery: ProgressDelivery,
  ) {}

  async follow(): Promise<void> {
    const finalRead = this.settled;
    await this.read();
    if (finalRead || Date.now() >= this.options.deadline) {
      return;
    }
    if (!this.settled) {
      // Journal polling is intentionally sequential so the cursor never overtakes a read.
      await this.waitForPoll();
    }
    return this.follow();
  }

  async drain(following: Promise<void>): Promise<void> {
    this.settled = true;
    this.drainStarted = Date.now();
    this.wake?.();
    if ((await settlesWithin(following, this.timing.drainMs)) === 'timeout') {
      this.delivery.warnings.emit('journal');
    }
    this.closed = true;
  }

  async reportFailure(): Promise<void> {
    if (this.failure) {
      await this.delivery.final(this.failure, this.drainStarted);
    }
  }

  async reportReady(url: string): Promise<void> {
    const event = this.ready?.url === url ? this.ready : this.synthesizedReady(url);
    if (event) {
      await this.delivery.final(event, this.drainStarted);
    }
  }

  private async read(): Promise<void> {
    try {
      const snapshot = await this.discovery.read(this.options.dataDir, {
        operationId: this.options.operationId,
        sequence: this.cursor,
      });
      if (snapshot.kind === 'events') {
        await this.replay(snapshot.events);
      }
    } catch {
      this.delivery.warnings.emit('journal');
    }
  }

  private async replay(events: readonly ProgressEvent[]): Promise<void> {
    const [event, ...later] = events;
    if (!event || this.closed) {
      return;
    }
    this.cursor = event.sequence;
    this.elapsedMs = Math.max(this.elapsedMs, event.elapsedMs);
    if (event.status === 'ready') {
      this.ready = event;
    } else if (event.status === 'failed') {
      this.failure = event;
    } else {
      await this.delivery.tick(event);
    }
    return this.replay(later);
  }

  private synthesizedReady(url: string): ProgressEvent | undefined {
    return parseProgressEvent({
      schemaVersion: PROGRESS_SCHEMA_VERSION,
      operationId: this.options.operationId,
      sequence: this.cursor + 1,
      phase: 'server-start',
      status: 'ready',
      elapsedMs: Math.max(this.elapsedMs, Date.now() - this.started),
      url,
    });
  }

  private waitForPoll(): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(
        finish,
        Math.max(0, Math.min(this.timing.pollMs, this.options.deadline - Date.now())),
      );
      this.wake = finish;
    });
  }
}

function settlement(operation: Promise<unknown>): Promise<Settlement> {
  return operation.then(
    () => 'fulfilled',
    () => 'rejected',
  );
}

async function settlesWithin(
  operation: Promise<unknown>,
  milliseconds: number,
): Promise<Settlement> {
  if (milliseconds <= 0) {
    return 'timeout';
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settlement(operation),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function writeWarning(message: string): void {
  process.stderr.write(`${message}\n`);
}
