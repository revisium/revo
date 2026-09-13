import type { ProgressEvent } from '../../../src/progress/progress-event.js';
import { parseProgressEvent } from '../../../src/progress/progress-event.parser.js';
import { ProgressOperation } from '../../../src/progress/progress-operation.js';
import { ProgressRenderer } from '../../../src/progress/progress-renderer.js';

const ID = '0123456789abcdef0123456789abcdef';

export class ProgressScenario {
  private now = 100;
  readonly operation = new ProgressOperation({ operationId: ID, now: () => this.now });

  transitionsAndCursors() {
    this.operation.start('runtime-download');
    this.now = 110;
    this.operation.progress('runtime-download', { counters: { bytesReceived: 7 } });
    const first = this.operation.eventsAfter(0);
    this.now = 120;
    this.operation.complete('runtime-download');
    return {
      first,
      after: this.operation.eventsAfter(2),
      duplicate: this.operation.eventsAfter(3),
    };
  }

  singleCurrentProgressRemainsOrdered() {
    this.operation.start('runtime-download');
    this.operation.progress('runtime-download', { counters: { bytesReceived: 1 } });
    this.operation.complete('runtime-download');
    this.operation.progress('runtime-download', { counters: { bytesReceived: 2 } });
    this.operation.start('runtime-extract');
    this.operation.progress('runtime-extract', { stageElapsedMs: 1 });
    return this.operation.eventsAfter(0);
  }

  clockRollbackAndImmutableSnapshots() {
    const started = this.operation.start('postgres-start');
    this.now = 150;
    this.operation.progress('postgres-start', {
      counters: { pnpmResolved: 2 },
      stageElapsedMs: 60,
    });
    this.now = 90;
    const completed = this.operation.complete('postgres-start');
    const snapshot = this.operation.eventsAfter(0);
    return {
      started,
      completed,
      snapshot,
      frozen: Object.isFrozen(snapshot) && snapshot.every(Object.isFrozen),
    };
  }

  invalidProgressLeavesOperationUsable() {
    this.operation.start('runtime-extract');
    const invalid = [
      { stageElapsedMs: Number.NaN },
      { stageElapsedMs: Number.POSITIVE_INFINITY },
      { stageElapsedMs: -1 },
      { stageElapsedMs: 999, counters: {} },
    ];
    let rejected = 0;
    for (const details of invalid) {
      try {
        this.operation.progress('runtime-extract', details);
      } catch {
        rejected += 1;
      }
    }
    this.now = 120;
    const progress = this.operation.progress('runtime-extract', { stageElapsedMs: 10 });
    const completed = this.operation.complete('runtime-extract');
    return {
      rejected,
      invalid: invalid.length,
      progress,
      completed,
      events: this.operation.eventsAfter(0),
    };
  }

  terminalBehavior() {
    const failed = this.operation.fail('api-readiness', {
      code: 'API_FAILED',
      logPath: '/safe/log',
    });
    const lateReady = this.operation.ready({ url: 'http://127.0.0.1:3210' });
    const lateProgress = this.operation.progress('api-readiness');
    return { failed, lateReady, lateProgress, events: this.operation.eventsAfter(0) };
  }

  reusedReady() {
    return this.operation.ready({ url: 'http://127.0.0.1:3210', reused: true });
  }

  malformedEvents() {
    const valid = this.operation.start('server-start');
    if (!valid) {
      throw new Error('fixture did not emit');
    }
    return [
      { ...valid, schemaVersion: 'wrong' },
      { ...valid, extra: true },
      { ...valid, elapsedMs: Number.NaN },
      { ...valid, phase: 'Bad phase' },
      { ...valid, status: 'progress', counters: { bytesReceived: -1 } },
      { ...valid, status: 'progress', counters: { imaginaryPercent: 50 } },
      { ...valid, sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, status: 'progress', counters: { bytesReceived: 1.5 } },
      { ...valid, status: 'failed', code: 'bad\ncode' },
      { ...valid, status: 'failed', code: 'FAILED', logPath: 'log\nforged' },
      { ...valid, status: 'ready', url: 'https://user:secret@example.com/' },
      { ...valid, status: 'ready', url: 'https://example.com/prefix' },
    ].map(parseProgressEvent);
  }

  extensionPhase() {
    const event = this.operation.start('plugin-bootstrap');
    return event && parseProgressEvent(event);
  }

  render(format: 'human' | 'jsonl', isTty: boolean) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const renderer = new ProgressRenderer({
      format,
      isTty,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    const started = this.operation.start('runtime-download');
    const progress = this.operation.progress('runtime-download', {
      counters: { bytesReceived: 12 },
    });
    const failed = this.operation.fail('runtime-download', { code: 'DOWNLOAD_FAILED' });
    for (const event of [started, progress, failed]) {
      if (event) {
        renderer.render(event);
      }
    }
    renderer.finish();
    return { stdout: stdout.join(''), stderr: stderr.join('') };
  }

  parsedJsonl(output: string): (ProgressEvent | undefined)[] {
    return output
      .trimEnd()
      .split('\n')
      .map((line) => parseProgressEvent(JSON.parse(line)));
  }

  ttyShortensWithoutResidue() {
    const stderr: string[] = [];
    const renderer = new ProgressRenderer({
      format: 'human',
      isTty: true,
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
    });
    const started = this.operation.start('dependencies-install');
    const long = this.operation.progress('dependencies-install', {
      counters: { pnpmResolved: 123_456, pnpmDownloaded: 123_456 },
    });
    const short = this.operation.progress('dependencies-install');
    for (const event of [started, long, short]) {
      if (event) {
        renderer.render(event);
      }
    }
    renderer.finish();
    return stderr.join('');
  }
}
