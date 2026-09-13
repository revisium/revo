import type { ProgressEvent } from './progress-event.js';

export interface ProgressRendererOptions {
  readonly format: 'human' | 'jsonl';
  readonly isTty: boolean;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export class ProgressRenderer {
  private lineOpen = false;
  private lineWidth = 0;
  private finished = false;
  constructor(private readonly options: ProgressRendererOptions) {}

  render(event: ProgressEvent): void {
    if (this.finished) {
      return;
    }
    if (this.options.format === 'jsonl') {
      this.options.stdout(`${JSON.stringify(event)}\n`);
      if (event.status === 'failed' || event.status === 'ready') {
        this.finished = true;
      }
      return;
    }
    if (event.status === 'ready') {
      this.closeLine();
      this.options.stdout(`${event.url}\n`);
      this.finished = true;
      return;
    }
    if (event.status === 'failed') {
      this.closeLine();
      this.options.stderr(
        `${event.phase}: failed [${event.code}]${event.logPath ? ` Log: ${event.logPath}` : ''}\n`,
      );
      this.finished = true;
      return;
    }
    const counters = renderCounters(event);
    const timing = ` ${event.elapsedMs}ms${event.stageElapsedMs === undefined ? '' : ` (stage ${event.stageElapsedMs}ms)`}`;
    const line = `${event.phase}: ${event.status}${timing}${counters}`;
    if (this.options.isTty && (event.status === 'started' || event.status === 'progress')) {
      const padding = ' '.repeat(Math.max(0, this.lineWidth - line.length));
      this.options.stderr(`\r${line}${padding}`);
      this.lineOpen = true;
      this.lineWidth = line.length;
    } else {
      this.closeLine();
      this.options.stderr(`${line}\n`);
    }
  }

  finish(): void {
    if (this.finished) {
      return;
    }
    this.closeLine();
    this.finished = true;
  }
  private closeLine() {
    if (!this.lineOpen) {
      return;
    }
    this.options.stderr('\n');
    this.lineOpen = false;
    this.lineWidth = 0;
  }
}

function renderCounters(event: ProgressEvent) {
  const counters = event.counters;
  if (!counters) {
    return '';
  }
  const values = [
    counters.bytesReceived === undefined ? undefined : `${counters.bytesReceived} bytes`,
    counters.bytesTotal === undefined ? undefined : `of ${counters.bytesTotal}`,
    counters.pnpmResolved === undefined ? undefined : `resolved ${counters.pnpmResolved}`,
    counters.pnpmReused === undefined ? undefined : `reused ${counters.pnpmReused}`,
    counters.pnpmDownloaded === undefined ? undefined : `downloaded ${counters.pnpmDownloaded}`,
    counters.pnpmAdded === undefined ? undefined : `added ${counters.pnpmAdded}`,
  ].filter((value): value is string => value !== undefined);
  return values.length ? ` (${values.join(', ')})` : '';
}
