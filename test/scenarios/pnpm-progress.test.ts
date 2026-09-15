import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runPackageProcess } from '../../src/installation/package-process.js';
import { PackageProgressRenderer } from '../../src/installation/package-progress-renderer.js';
import {
  createPnpmProgressSink,
  PnpmProgressParser,
} from '../../src/installation/pnpm-progress.js';
import {
  PNPM12_TRANSCRIPTS,
  pnpmProgressScenario,
} from '../support/installation/pnpm-progress-scenario.js';

describe('pnpm NDJSON progress', () => {
  it('normalizes genuine pnpm 12 cold and warm transcripts without totals', () => {
    const cold = pnpmProgressScenario();
    const warm = pnpmProgressScenario(PNPM12_TRANSCRIPTS.warm);
    expect(cold.at(-1)).toMatchObject({ stage: 'install', status: 'completed', added: 1 });
    expect(cold.find((event) => event.downloaded)).toMatchObject({ downloaded: 1 });
    expect(warm.every((event) => event.total === undefined)).toBe(true);
    expect(PNPM12_TRANSCRIPTS.failure).toContain('ERR_PNPM_BROKEN_LOCKFILE');
  });

  it('handles split UTF-8 records, final records without newline, duplicates, and rollback', () => {
    const raw: string[] = [];
    const parser = new PnpmProgressParser({ now: () => 50, onRaw: (line) => raw.push(line) });
    const input = '{"time":100,"name":"pnpm:progress","status":"resolved","packageId":"é@1"}\n';
    const first = parser.feed(new TextEncoder().encode(input).subarray(0, 4));
    const second = parser.feed(new TextEncoder().encode(input).subarray(4));
    const duplicate = parser.feed(input);
    parser.feed('{"time":90,"name":"pnpm:progress","status":"resolved","packageId":"x@1"}');
    const tail = parser.finish();
    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
    expect(duplicate).toEqual([]);
    expect(tail[0]).toMatchObject({ elapsedMs: 0, resolved: 2 });
    expect(parser.finish()).toEqual([]);
    expect(raw).toEqual([]);
  });

  it('bounds malformed and unknown records and keeps raw input out of events', () => {
    const raw: Array<[string, string]> = [];
    const parser = new PnpmProgressParser({
      maxLineBytes: 128,
      onRaw: (line, reason) => raw.push([line, reason]),
    });
    expect(parser.feed('{bad}\n')).toEqual([]);
    expect(parser.feed('{"name":"other","message":"secret"}\n')).toEqual([]);
    expect(parser.feed('x'.repeat(200) + '\n')).toEqual([]);
    expect(raw.map(([, reason]) => reason)).toEqual(['malformed', 'unknown', 'oversized']);
  });

  it('falls back to bounded activity for valid unknown pnpm records', () => {
    const events = pnpmProgressScenario('{"time":10,"name":"pnpm","message":"checking…"}');
    expect(events[0]).toMatchObject({
      stage: 'install',
      status: 'progress',
      activity: 'checking…',
    });
  });

  it('renders throttled non-TTY snapshots and one cleared TTY line with a final newline', () => {
    const events = pnpmProgressScenario();
    const nonTty: string[] = [];
    const renderer = new PackageProgressRenderer({
      isTty: false,
      write: (value) => nonTty.push(value),
      now: () => 0,
    });
    events.forEach((event) => renderer.render(event));
    renderer.finish();
    expect(nonTty.join('')).not.toContain('\x1b');
    expect(nonTty.join('')).toContain('install: completed');
    const tty: string[] = [];
    const ttyRenderer = new PackageProgressRenderer({
      isTty: true,
      write: (value) => tty.push(value),
      now: () => 0,
    });
    const first = events.at(0);
    if (first === undefined) {
      throw new Error('progress transcript is empty');
    }
    ttyRenderer.render({ ...first, activity: 'bad\nline\x1b[31m' });
    ttyRenderer.finish();
    expect(tty.join('')).toContain('\r\x1b[2K');
    expect(tty.join('').endsWith('\n')).toBe(true);
    expect(tty.join('')).not.toContain('bad\n');
  });

  it('emits a terminal failure for nonzero process results and disposes parser output', () => {
    const events: string[] = [];
    const sink = createPnpmProgressSink({ onEvent: (event) => events.push(event.status) });
    sink.feed(PNPM12_TRANSCRIPTS.cold);
    sink.finish({ exitCode: 7, signal: null });
    expect(events.at(-1)).toBe('failed');
  });

  it('streams pnpm stdout into the progress sink and reports process failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-pnpm-progress-'));
    const events: string[] = [];
    const sink = createPnpmProgressSink({ onEvent: (event) => events.push(event.status) });
    await runPackageProcess({
      executable: process.execPath,
      args: [
        '-e',
        "console.log(JSON.stringify({time:100,name:'pnpm:progress',status:'resolved',packageId:'demo@1'}))",
      ],
      cwd: root,
      env: { PATH: root },
      diagnosticPath: `${root}/progress.log`,
      progress: sink,
    });
    expect(events).toContain('progress');
    await rm(root, { recursive: true, force: true });
  });
});
