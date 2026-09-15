// oxlint-disable curly -- compact renderer state transitions stay bounded and explicit

import type { PnpmProgressEvent } from './pnpm-progress.js';

export interface PackageProgressRendererOptions {
  readonly isTty: boolean;
  readonly write: (text: string) => void;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly maxLineLength?: number;
}

const clean = (value: string): string =>
  Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && (code < 0x7f || code > 0x9f);
    })
    .join('');
const details = (event: PnpmProgressEvent): string =>
  [
    event.resolved === undefined ? undefined : `resolved ${event.resolved}`,
    event.downloaded === undefined ? undefined : `downloaded ${event.downloaded}`,
    event.reused === undefined ? undefined : `reused ${event.reused}`,
    event.added === undefined ? undefined : `added ${event.added}`,
    event.total === undefined ? undefined : `of ${event.total}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join(', ');

export class PackageProgressRenderer {
  private readonly now: () => number;
  private readonly interval: number;
  private readonly maxLength: number;
  private lastWrite = -Infinity;
  private lineOpen = false;
  private finished = false;
  constructor(private readonly options: PackageProgressRendererOptions) {
    this.now = options.now ?? Date.now;
    this.interval = options.intervalMs ?? 200;
    this.maxLength = options.maxLineLength ?? 240;
  }
  render(event: PnpmProgressEvent): void {
    if (this.finished) return;
    const terminal = event.status === 'failed';
    const transition = terminal || event.status === 'completed';
    const now = this.now();
    if (!transition && now - this.lastWrite < this.interval) return;
    const suffix = details(event);
    const detailsText = suffix ? ` (${suffix})` : '';
    const activity = event.activity === undefined ? '' : ` ${event.activity}`;
    const raw = `${event.stage}: ${event.status} ${event.elapsedMs}ms${detailsText}${activity}`;
    const line = clean(raw).slice(0, this.maxLength);
    if (this.options.isTty) {
      this.options.write(`\r\x1b[2K${line}`);
      this.lineOpen = true;
    } else {
      if (this.lineOpen) this.options.write('\n');
      this.options.write(`${line}\n`);
      this.lineOpen = false;
    }
    this.lastWrite = now;
    if (terminal) this.finish();
  }
  finish(): void {
    if (this.finished) return;
    if (this.lineOpen) this.options.write('\n');
    this.lineOpen = false;
    this.finished = true;
  }
}

export const renderPackageProgress = (
  events: readonly PnpmProgressEvent[],
  options: PackageProgressRendererOptions,
): string => {
  const output: string[] = [];
  const renderer = new PackageProgressRenderer({ ...options, write: (text) => output.push(text) });
  events.forEach((event) => renderer.render(event));
  renderer.finish();
  return output.join('');
};
