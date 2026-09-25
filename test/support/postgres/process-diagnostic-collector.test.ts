import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type {
  ManagedProcessRequest,
  OwnedProcess,
} from '../../../src/processes/managed-process.types.js';
import { PostgresProcessDiagnosticCollector } from './process-diagnostic-collector.js';

describe('PostgresProcessDiagnosticCollector', () => {
  it('redacts paths, credentials, ANSI, and connection strings while preserving lifecycle evidence', async () => {
    const dataDirectory = '/private/revo/data';
    const collector = new PostgresProcessDiagnosticCollector(dataDirectory);
    const controller = new AbortController();
    const id = collector.startRequested({
      owner: 'first',
      request: request(dataDirectory, controller.signal),
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let completionReads = 0;
    const completion = Promise.resolve({ exitCode: 1, signal: null } as const);
    const handle: OwnedProcess = {
      stdout,
      stderr,
      completion,
      get cancellationResult() {
        completionReads += 1;
        return Promise.resolve({ kind: 'not-requested' } as const);
      },
    };

    collector.processStarted(id, handle);
    controller.abort();
    stdout.end('NOTICE password=stdout-secret /private/revo/data\n');
    stderr.end(
      '\u001b[31mFATAL password=do-not-print postgres://user:secret@host/db /private/revo/data\u001b[0m\n',
    );
    await collector.waitForStderr(250);
    const report = collector.formatReport('restart-failed', new Error('password=also-secret'));
    const payload = JSON.parse(report.slice(report.indexOf('{')));

    expect(report).toContain('process-cancellation-signal');
    expect(report).toContain('process-completed');
    expect(report).toContain('FATAL');
    expect(report).toContain('NOTICE');
    expect(report).toContain('<data-dir>');
    expect(report).not.toContain('do-not-print');
    expect(report).not.toContain('also-secret');
    expect(report).not.toContain('user:secret');
    expect(report).not.toContain('stdout-secret');
    expect(report).not.toContain('/private/revo/data');
    expect(report).not.toContain('\u001b');
    expect(payload.processes[0]).toMatchObject({
      id: 1,
      owner: 'first',
      role: 'postgres',
      completion: { exitCode: 1, signal: null },
      cancellationResult: 'not-requested',
    });
    expect(payload.processes[0].stdout).toContain('NOTICE');
    expect(payload.processes[0].stdoutLastOutputAtMs).toBeTypeOf('number');
    expect(completionReads).toBeGreaterThan(0);
    expect(handle.completion).toBe(completion);
  });

  it('bounds stderr per process, total report size, and trace event count', async () => {
    const collector = new PostgresProcessDiagnosticCollector('/private/revo/data');
    const id = collector.startRequested({ owner: 'first', request: request('/private/revo/data') });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const handle: OwnedProcess = {
      stdout,
      stderr,
      completion: Promise.resolve({ exitCode: 0, signal: null }),
    };
    collector.processStarted(id, handle);
    stdout.end(Buffer.alloc(48 * 1024, 0x62));
    stderr.end(Buffer.alloc(48 * 1024, 0x61));
    for (let index = 0; index < 400; index += 1) {
      collector.scenario('bounded-event', { index, detail: 'x'.repeat(800) });
    }
    await collector.waitForStderr(250);
    const report = collector.formatReport('complete');
    const payload = JSON.parse(report.slice(report.indexOf('{')));

    expect(Buffer.byteLength(report)).toBeLessThanOrEqual(128 * 1024);
    expect(Buffer.byteLength(payload.processes[0].stderr)).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(payload.processes[0].stdout)).toBeLessThanOrEqual(16 * 1024);
    expect(payload.events.length).toBeLessThanOrEqual(256);
    expect(payload.droppedEvents).toBeGreaterThan(0);
    expect(payload.processes[0].stderrBytes).toBe(48 * 1024);
    expect(payload.processes[0].stderrDiscardedBytes).toBeGreaterThan(0);
    expect(payload.processes[0].stdoutBytes).toBe(48 * 1024);
    expect(payload.processes[0].stdoutDiscardedBytes).toBeGreaterThan(0);
  });

  it('marks an output stream incomplete when it does not settle within observation bound', async () => {
    const collector = new PostgresProcessDiagnosticCollector('/private/revo/data');
    const id = collector.startRequested({ owner: 'first', request: request('/private/revo/data') });
    const stdout = new PassThrough();
    collector.processStarted(id, {
      stdout,
      completion: Promise.resolve({ exitCode: null, signal: 'SIGTERM' }),
    });

    await collector.waitForStderr(1);
    const report = collector.formatReport('incomplete');
    const payload = JSON.parse(report.slice(report.indexOf('{')));
    expect(payload.processes[0].stdoutCaptureIncomplete).toBe(true);
    stdout.destroy();
  });
});

function request(
  dataDirectory: string,
  signal = new AbortController().signal,
): ManagedProcessRequest {
  return {
    executable: '/private/toolchain/postgres',
    args: [
      '-D',
      dataDirectory,
      '-h',
      '127.0.0.1',
      '-p',
      '5432',
      '-c',
      'cluster_name=revo-0123456789abcdef0123456789abcdef',
    ],
    cwd: dataDirectory,
    env: { LC_ALL: 'C' },
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    cancellation: { signal, graceMs: 10_000, killWaitMs: 5000 },
  };
}
