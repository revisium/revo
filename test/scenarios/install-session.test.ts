import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  InstallSessionScenario,
  startupTranscript,
  foreignStartupTranscript,
} from '../support/installation/install-session-scenario.js';
import { PNPM12_TRANSCRIPTS } from '../support/installation/pnpm-progress-scenario.js';

describe('installer activation and startup session', () => {
  it('uses the receipt generation, reassembles JSONL, and publishes URL only after successful CLI exit', async () => {
    const scenario = new InstallSessionScenario();
    await expect(scenario.start()).resolves.toMatchObject({ status: 'ready' });
    expect(scenario.requests).toHaveLength(1);
    expect(scenario.requests[0]).toMatchObject({
      executable: `${scenario.root}/activations/${'a'.repeat(64)}/revo`,
      args: ['server', 'start', '--progress=jsonl', '--channel', 'stable'],
      cwd: '/private/package',
      env: { REVO_CHANNEL: 'stable', PATH: '/private/node/bin:/usr/bin:/bin', NODE_PATH: '' },
    });
    expect(scenario.beforeExit).toBe('');
    expect(scenario.text()).toContain('http://127.0.0.1:3210\n');
    expect(scenario.text()).toContain("'\"'\"'");
    expect(scenario.text()).toContain('export PATH="${PATH:+$PATH:}"');
    expect(scenario.text()).toContain('Existing revo commands keep priority');
  });

  it.each(['busy', 'failed', 'cancelled'])(
    'never starts an unconfirmed %s activation',
    async (status) => {
      const scenario = new InstallSessionScenario();
      await expect(scenario.start(status)).rejects.toThrow('ACTIVATION_UNCONFIRMED');
      expect(scenario.requests).toEqual([]);
      expect(scenario.text()).toBe('');
    },
  );

  it('accepts healthy same-generation reuse through the installed CLI', async () => {
    const scenario = new InstallSessionScenario({ transcript: startupTranscript(true) });
    await expect(scenario.start('unchanged')).resolves.toMatchObject({ reused: true });
    expect(scenario.requests).toHaveLength(1);
  });

  it.each([
    '{private malformed}\n',
    startupTranscript().trimEnd(),
    startupTranscript() + startupTranscript(),
    foreignStartupTranscript(),
    'x'.repeat(256 * 1024 + 1),
  ])('rejects unsafe or incomplete progress without URL or PATH success %#', async (transcript) => {
    const scenario = new InstallSessionScenario({ transcript });
    await expect(scenario.start()).rejects.toThrow('START_PROGRESS_INVALID');
    expect(scenario.text()).toBe('');
    expect(scenario.errors.join('')).not.toContain('private malformed');
  });

  it('does not present ready from a failed CLI or retry the start', async () => {
    const scenario = new InstallSessionScenario({ exitCode: 1 });
    await expect(scenario.start()).rejects.toThrow('SERVER_START_FAILED');
    expect(scenario.text()).toBe('');
    expect(scenario.requests).toHaveLength(1);
  });

  it('renders actual pnpm counters while keeping raw diagnostic messages private', () => {
    const scenario = new InstallSessionScenario();
    scenario.session.stage('validate');
    scenario.session.stage('dependencies');
    scenario.session.packageProgress.feed(PNPM12_TRANSCRIPTS.cold + '\n');
    scenario.session.packageProgress.feed('{"name":"pnpm","message":"private-token"}\n');
    scenario.session.packageProgress.finish({ exitCode: 0, signal: null });
    scenario.session.stage('activation');
    const output = scenario.errors.join('');
    expect(output).toContain('downloaded 1');
    expect(output).toContain('resolved 1');
    expect(output).not.toContain('private-token');
    expect(output).not.toContain('%');
  });

  it('finishes once and reports failures without copying arbitrary error text', async () => {
    const scenario = new InstallSessionScenario();
    scenario.session.stage('package-download');
    await scenario.session.finish();
    const finished = scenario.errors.join('');
    await scenario.session.finish();
    scenario.session.stage('activation');
    expect(scenario.errors.join('')).toBe(finished);
    await scenario.session.fail(undefined, new Error('private-token'));
    expect(scenario.errors.join('')).toContain('INSTALL_SESSION_FAILED');
    expect(scenario.errors.join('')).not.toContain('private-token');
  });

  it('disables broken progress output without aborting or retrying server startup', async () => {
    const scenario = new InstallSessionScenario({ outputFailure: true });
    scenario.session.stage('server');
    await expect(scenario.start()).rejects.toThrow('INSTALL_PROGRESS_OUTPUT_FAILED');
    expect(scenario.requests).toHaveLength(1);
    expect(scenario.text()).toBe('');
  });

  it('keeps stderr diagnostics available when stdout fails', async () => {
    const scenario = new InstallSessionScenario({ stdoutFailure: true });
    await expect(scenario.start()).rejects.toThrow('INSTALL_PROGRESS_OUTPUT_FAILED');
    await scenario.session.fail(undefined, new Error('private-token'));
    expect(scenario.errors.join('')).toContain('INSTALL_SESSION_FAILED');
  });

  it('bounds a writable that never acknowledges progress output', async () => {
    const hung = new Writable({ write: () => undefined });
    const scenario = new InstallSessionScenario({ stdoutSink: hung, outputTimeoutMs: 250 });
    await expect(scenario.start()).rejects.toThrow('INSTALL_PROGRESS_OUTPUT_FAILED');
    hung.destroy();
  });

  it('accepts the null error passed to a successful Writable callback', async () => {
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback(null);
      },
    });
    const scenario = new InstallSessionScenario({ stdoutSink: stdout });
    await expect(scenario.start()).resolves.toMatchObject({ status: 'ready' });
    stdout.destroy();
  });

  it('clears queued output when an active channel exceeds its bounded budget', async () => {
    const callbacks: Array<(error?: Error | null) => void> = [];
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callbacks.push(callback);
      },
    });
    const scenario = new InstallSessionScenario({ stdoutSink: stdout });
    scenario.writeStdout('active');
    scenario.writeStdout('queued');
    scenario.writeStdout('x'.repeat(512 * 1024));
    const finished = scenario.session.finish();
    callbacks[0]?.(null);
    await expect(
      Promise.race([
        finished,
        new Promise((_, reject) => setTimeout(() => reject(new Error('flush timeout')), 500)),
      ]),
    ).rejects.toThrow('INSTALL_PROGRESS_OUTPUT_FAILED');
    stdout.destroy();
  });
});
