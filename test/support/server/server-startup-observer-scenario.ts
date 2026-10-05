import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProgressOperation, type ProgressEvent } from '../../../src/progress/index.js';
import {
  ServerStartupObserver,
  type ServerProgressSink,
  type StartupObserverTiming,
} from '../../../src/server/server-startup-observer.js';
import {
  StartupProgressDiscoveryService,
  StartupProgressJournalWriter,
} from '../../../src/startup-progress/startup-progress-journal.service.js';
import {
  OPERATION_ID,
  PUBLIC_URL,
  ServerLaunchAttemptScenario,
} from './server-launch-attempt-scenario.js';

export const FAST: StartupObserverTiming = { deliveryMs: 50, drainMs: 200, pollMs: 5 };
export const JOURNAL_WARNING =
  'Warning: skipped startup progress because the progress journal could not be read in time.';
export const OUTPUT_WARNING =
  'Warning: skipped startup progress because progress output could not be written in time.';

type JournalRead = 'fail' | 'hang';

export class ServerStartupObserverScenario {
  readonly attempt = new ServerLaunchAttemptScenario();
  readonly events: ProgressEvent[] = [];
  readonly warnings: string[] = [];
  readonly operation = new ProgressOperation({ operationId: OPERATION_ID, now: () => 0 });
  reads = 0;
  observedReady = false;
  private root = '';
  private dataDir = '';

  async open(): Promise<this> {
    this.root = await mkdtemp(join(tmpdir(), 'revo-observer-'));
    this.dataDir = join(this.root, 'data');
    await mkdir(this.dataDir, { mode: 0o700 });
    await this.attempt.load();
    return this;
  }

  static async reuse(
    url: string | undefined,
    sink?: ServerProgressSink,
  ): Promise<{ outcome: string; events: ProgressEvent[]; warnings: string[] }> {
    const events: ProgressEvent[] = [];
    const warnings: string[] = [];
    const observer = new ServerStartupObserver(
      new StartupProgressDiscoveryService(),
      (message) => warnings.push(message),
      FAST,
    );
    const outcome = await observer
      .reused(
        url,
        sink ??
          ((event) => {
            events.push(event);
          }),
        'f'.repeat(32),
      )
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    return { outcome, events, warnings };
  }

  start(
    sink: ServerProgressSink = (event) => {
      this.events.push(event);
    },
    options: { readonly read?: JournalRead; readonly timing?: StartupObserverTiming } = {},
  ) {
    const pending = this.attempt.start();
    const discovery = new StartupProgressDiscoveryService();
    const observer = new ServerStartupObserver(
      {
        read: async (dataDir, cursor) => {
          if (options.read === 'fail') {
            throw new Error('private journal failure');
          }
          if (options.read === 'hang') {
            return new Promise<never>(() => undefined);
          }
          const snapshot = await discovery.read(dataDir, cursor);
          this.reads += 1;
          this.observedReady ||=
            snapshot.kind === 'events' && snapshot.events.some((event) => event.status === 'ready');
          return snapshot;
        },
      },
      (message) => this.warnings.push(message),
      options.timing,
    );
    return observer.observe(pending, {
      dataDir: this.dataDir,
      operationId: OPERATION_ID,
      deadline: this.attempt.deadline,
      sink,
    });
  }

  async publish(operation = this.operation, operationId = OPERATION_ID) {
    await new StartupProgressJournalWriter().write(
      this.dataDir,
      operationId,
      operation.eventsAfter(0),
    );
  }

  async malformed() {
    await writeFile(join(this.dataDir, '.revo-progress.json'), '{private malformed', {
      mode: 0o600,
    });
  }

  async ready() {
    this.operation.ready({ url: PUBLIC_URL });
    await this.publish();
    await this.readyOverIpcOnly();
  }

  async readyOverIpcOnly() {
    this.attempt.booted();
    this.attempt.deliver('start');
    await Promise.resolve();
    this.attempt.ready();
    this.attempt.deliver('commit');
    await Promise.resolve();
  }

  async close() {
    this.attempt.abort();
    this.attempt.exit(0);
    await rm(this.root, { recursive: true, force: true });
  }
}
