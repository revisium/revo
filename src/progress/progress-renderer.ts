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
      const logSuffix = event.logPath ? ` Log: ${event.logPath}` : '';
      this.options.stderr(`${event.phase}: failed [${event.code}]${logSuffix}\n`);
      this.finished = true;
      return;
    }
    const stageTiming =
      event.stageElapsedMs === undefined ? '' : ` (stage ${event.stageElapsedMs}ms)`;
    const timing = ` ${event.elapsedMs}ms${stageTiming}`;
    const line = `${event.phase}: ${event.status}${timing}`;
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
