import { describe, expect, it } from 'vitest';

import type { ServerLaunchResult } from '../../src/server/server-launcher.service.js';
import { TuiCommandScenario, type TuiCommandFixture } from '../support/cli/tui-command-scenario.js';

const run = (args: readonly string[], fixture: Readonly<TuiCommandFixture> = {}) =>
  TuiCommandScenario.run(args[0] === 'tui' ? args : ['tui', ...args], fixture);

describe('revo tui command', () => {
  it('starts with the resolved config snapshot and launches TUI in that data directory', async () => {
    const result = await run(
      [
        'tui',
        '--channel',
        'alpha',
        '--config',
        '/fixture/alpha.json',
        '--data-dir',
        '/fixture/alpha-data',
        '--startup-timeout',
        '45000',
      ],
      {
        outcome: { kind: 'started', url: 'https://revo.example/' },
        resolvedChannel: 'alpha',
        resolvedDataDir: '/fixture/alpha-data',
      },
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: '', stdout: '' });
    expect(result.events).toEqual(['ensure', 'launch']);
    expect(result.ensures).toEqual([
      {
        channel: 'alpha',
        config: '/fixture/alpha.json',
        dataDir: '/fixture/alpha-data',
        startupTimeout: '45000',
      },
    ]);
    expect(result.launches).toEqual([
      { apiUrl: 'https://revo.example/graphql', dataDir: '/fixture/alpha-data/tui' },
    ]);
  });

  it('reuses the advertised URL of a running server', async () => {
    const result = await run([], {
      outcome: {
        kind: 'running',
        status: { phase: 'running', publicUrl: 'http://127.0.0.1:3210' },
      },
    });

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.events).toEqual(['ensure', 'launch']);
    expect(result.launches).toEqual([
      { apiUrl: 'http://127.0.0.1:3210/graphql', dataDir: '/fixture/stable-data/tui' },
    ]);
  });

  it.each([
    { stdinTTY: false, stdoutTTY: true },
    { stdinTTY: true, stdoutTTY: false },
  ])(
    'rejects a missing TTY before resolving config or starting the server: $stdinTTY/$stdoutTTY',
    async (tty) => {
      const result = await run([], tty);

      expect(result).toMatchObject({
        exitCode: 1,
        stderr: 'revo tui requires a TTY on stdin and stdout.\n',
        stdout: '',
      });
      expect(result.events).toEqual([]);
      expect(result.ensures).toEqual([]);
      expect(result.launches).toEqual([]);
    },
  );

  it.each([
    { outcome: { kind: 'stopped' }, stderr: 'Server did not start.\n' },
    {
      outcome: { kind: 'starting', status: { phase: 'starting' } },
      stderr: 'Server is starting; start was not performed.\n',
    },
    {
      outcome: { kind: 'unknown' },
      stderr: 'Server status is unavailable; start was not performed.\n',
    },
    {
      outcome: { kind: 'missing' },
      stderr: 'Server status is unavailable; start was not performed.\n',
    },
  ] as const satisfies readonly { outcome: ServerLaunchResult; stderr: string }[])(
    'does not launch TUI when the server outcome is $outcome.kind',
    async ({ outcome, stderr }) => {
      const result = await run([], { outcome });

      expect(result).toMatchObject({ exitCode: 1, stderr, stdout: '' });
      expect(result.events).toEqual(['ensure']);
      expect(result.launches).toEqual([]);
    },
  );

  it.each([
    {
      outcome: { kind: 'running', status: { phase: 'running' } },
      stderr: 'Server is running, but its public URL is unavailable.\n',
    },
    {
      outcome: { kind: 'started', url: 'https://revo.example/path' },
      stderr: 'Server public URL is invalid.\n',
    },
  ] as const satisfies readonly { outcome: ServerLaunchResult; stderr: string }[])(
    'rejects an unusable public URL before launching TUI',
    async ({ outcome, stderr }) => {
      const result = await run([], { outcome });

      expect(result).toMatchObject({ exitCode: 1, stderr, stdout: '' });
      expect(result.launches).toEqual([]);
    },
  );

  it('preserves the launcher exit code and does not stop the server', async () => {
    const result = await run([], { exitCode: 37 });

    expect(result).toMatchObject({ exitCode: 37, stderr: '', stdout: '' });
    expect(result.events).toEqual(['ensure', 'launch']);
  });

  it('reports launcher errors without stopping the ready server', async () => {
    const result = await run([], { launchError: new Error('TUI spawn failed safely.') });

    expect(result).toMatchObject({
      exitCode: 1,
      stderr: 'TUI spawn failed safely.\n',
      stdout: '',
    });
    expect(result.events).toEqual(['ensure', 'launch']);
  });

  it('registers the command and rejects unsupported arguments', async () => {
    const help = await run(['tui', '--help']);
    const extra = await run(['tui', 'unexpected']);
    const option = await run(['tui', '--port', '3210']);

    expect(help).toMatchObject({ exitCode: 0, stderr: '' });
    expect(help.stdout).toContain('Usage: revo tui');
    expect(help.stdout).toContain('--channel <channel>');
    expect(extra.exitCode).toBe(2);
    expect(option.exitCode).toBe(2);
    expect(extra.events).toEqual([]);
    expect(option.events).toEqual([]);
  });
});
