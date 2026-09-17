import { Inject, Injectable } from '@nestjs/common';

import { ProgressOperation, type ProgressEvent } from '../progress/index.js';
import { StartupProgressDiscoveryService } from '../startup-progress/index.js';
import type { StartedServer } from './server-launch-attempt.js';

export type ServerProgressSink = (event: ProgressEvent) => void | Promise<void>;
const DELIVERY_MILLISECONDS = 250;
const POLL_MILLISECONDS = 25;

export class StartProgressOutputError extends Error {
  readonly code = 'START_PROGRESS_OUTPUT_FAILED';
  constructor() {
    super('Server is running, but startup progress output failed.');
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
  constructor(
    @Inject(StartupProgressDiscoveryService)
    private readonly discovery: Pick<
      StartupProgressDiscoveryService,
      'read'
    > = new StartupProgressDiscoveryService(),
  ) {}

  async observe(attempt: Promise<StartedServer>, options: Observation): Promise<StartedServer> {
    const session = new JournalObservation(this.discovery, options);
    // Attach both handlers immediately; observation never owns attempt cancellation or cleanup.
    const outcome = attempt.then(
      (value) => {
        session.settled();
        return { kind: 'started' as const, value };
      },
      (error: unknown) => {
        session.settled();
        return { kind: 'failed' as const, error };
      },
    );
    await session.follow();
    const result = await outcome;
    if (result.kind === 'failed') {
      throw result.error;
    }
    await session.finish(result.value.url);
    return result.value;
  }

  async reused(
    url: string | undefined,
    sink: ServerProgressSink,
    operationId: string,
  ): Promise<void> {
    const operation = new ProgressOperation({ operationId, now: Date.now });
    try {
      if (!url) {
        throw new StartProgressOutputError();
      }
      const event = operation.ready({ url, reused: true });
      if (!event) {
        throw new StartProgressOutputError();
      }
      await bounded(() => sink(event), Date.now() + DELIVERY_MILLISECONDS);
    } catch {
      throw new StartProgressOutputError();
    }
  }
}

class JournalObservation {
  private sequence = 0;
  private ready: ProgressEvent | undefined;
  private disabled = false;
  private done = false;
  private deadline: number;
  private wake: (() => void) | undefined;

  constructor(
    private readonly discovery: Pick<StartupProgressDiscoveryService, 'read'>,
    private readonly options: Observation,
  ) {
    this.deadline = options.deadline;
  }

  settled(): void {
    this.done = true;
    // Bound the entire remaining replay, not just each individual sink invocation.
    this.deadline = Math.min(this.deadline, Date.now() + DELIVERY_MILLISECONDS);
    this.wake?.();
  }

  async follow(): Promise<void> {
    if (this.done || this.disabled || Date.now() >= this.deadline) {
      if (!this.disabled) {
        await this.read();
      }
      return;
    }
    await this.read();
    if (!this.done && !this.disabled) {
      // Journal polling is intentionally sequential so the cursor never overtakes a read.
      await this.wait();
    }
    return this.follow();
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, Math.min(POLL_MILLISECONDS, this.deadline - Date.now()));
      this.wake = finish;
    });
  }

  async finish(url: string): Promise<void> {
    if (!this.disabled && this.ready?.url === url) {
      await this.deliver(this.ready);
    } else {
      this.disabled = true;
    }
    if (this.disabled) {
      throw new StartProgressOutputError();
    }
  }

  private async read(): Promise<void> {
    try {
      // Each read must finish before the next cursor-bearing read starts.
      const snapshot = await bounded(
        () =>
          this.discovery.read(this.options.dataDir, {
            operationId: this.options.operationId,
            sequence: this.sequence,
          }),
        this.deadline,
      );
      if (snapshot.kind !== 'events') {
        return;
      }
      await this.replay(snapshot.events);
    } catch {
      this.disabled = true;
    }
  }

  private async replay(events: readonly ProgressEvent[]): Promise<void> {
    for (const event of events) {
      if (this.disabled) {
        return;
      }
      this.sequence = event.sequence;
      if (event.status === 'ready') {
        this.ready = event;
      } else {
        // Preserve journal order and backpressure between domain events.
        // oxlint-disable-next-line no-await-in-loop
        await this.deliver(event);
      }
    }
  }

  private async deliver(event: ProgressEvent): Promise<void> {
    try {
      await bounded(() => this.options.sink(event), this.deadline);
    } catch {
      this.disabled = true;
    }
  }
}

async function bounded<T>(operation: () => T | Promise<T>, deadline: number): Promise<T> {
  const remaining = Math.min(DELIVERY_MILLISECONDS, deadline - Date.now());
  if (remaining <= 0) {
    throw new StartProgressOutputError();
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StartProgressOutputError()), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
