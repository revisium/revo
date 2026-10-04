import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigurationError } from '../../src/configuration/configuration-error.js';
import { ManagedProcessError } from '../../src/processes/managed-process-error.js';
import { ProgressOperation, parseProgressEvent } from '../../src/progress/index.js';
import type { ServerLaunchResult } from '../../src/server/server-launcher.service.js';
import type { ServerStatus } from '../../src/server/server-status.service.js';
import { SERVER_STOP_CONFIRMATION_MS } from '../../src/server/server-stop.service.js';
import { CliScenario } from '../support/cli/cli-scenario.js';
import { ProgressOutputScenario } from '../support/cli/progress-output-scenario.js';
import {
  FIXTURE_DATA_DIR,
  ServerCommandScenario,
  serverStatus,
  type ServerCommandFixture,
} from '../support/cli/server-command-scenario.js';
import { ServerLogFixture } from '../support/server-logs/server-log-fixture.js';

type Cmd = 'status' | 'stop';
type Kind = ServerStatus['kind'];
type InspectRow = { calls: number; cmd: Cmd; code: number; err: string; kind: Kind; out: string };

/** Every start option paired with its camelCase flag name and a distinguishable value. */
const START_OPTIONS = [
  ['--channel <channel>', 'channel', 'alpha'],
  ['--config <path>', 'config', '/fixture/custom.json'],
  ['--database-url <url>', 'databaseUrl', 'postgres://db.invalid/revo'],
  ['--data-dir <path>', 'dataDir', '/fixture/custom-data'],
  ['--host <host>', 'host', '0.0.0.0'],
  ['--log-dir <path>', 'logDir', '/fixture/custom-logs'],
  ['--port <port>', 'port', '3300'],
  ['--public-url <url>', 'publicUrl', 'https://revo.invalid'],
  ['--startup-timeout <milliseconds>', 'startupTimeout', '60000'],
] as const;
const START_ARGV = START_OPTIONS.flatMap(([usage, , value]) => [usage.split(' ')[0] ?? '', value]);
const START_FLAGS = Object.fromEntries(START_OPTIONS.map(([, name, value]) => [name, value]));

const STARTED: ServerLaunchResult = { kind: 'started', url: 'http://127.0.0.1:3210' };
const started = async () => STARTED;
const UNAVAILABLE = 'Server status is unavailable';
const NO_START = `${UNAVAILABLE}; start was not performed.\n`;
const NO_STOP = `${UNAVAILABLE}; stop was not performed.\n`;
const STOPPED = 'Server stopped.\n';
const ALREADY_STOPPED = 'Server is already stopped.\n';
const STOP_CALL = { dataDir: FIXTURE_DATA_DIR, timeoutMs: SERVER_STOP_CONFIRMATION_MS };
const CANCELLED = 'Server start was cancelled.\n';
const FAILED = 'Server start failed.\n';
const OUTCOME = 'Server start outcome is unknown.\n';
const RETAINED = 'Server start failed. Resources may remain active.\n';
const UNCONFIRMED = 'Server start outcome is unknown. Cleanup could not be confirmed.\n';
const SILENT_PENDING = { listeners: { sigint: 1, sigterm: 1 }, stderr: '', stdout: '' };
const NO_LISTENERS = { sigint: 0, sigterm: 0 };
const refused = (kind: string) => `Server is ${kind}; start was not performed.\n`;
const reported = (kind: string) => `Server is ${kind}.\n`;

const run = (args: readonly string[], fixture?: Readonly<ServerCommandFixture>) =>
  ServerCommandScenario.run(args, fixture);

function launchError(code: string, cleanup?: string): Error {
  const failure = Object.assign(new Error('Server launch attempt failed.'), { code });
  return cleanup === undefined ? failure : Object.assign(failure, { cleanup });
}

function configurationFailure(exitCode: 1 | 2, message: string): ConfigurationError {
  const code = exitCode === 1 ? 'revo.configuration.file' : 'revo.configuration.invalid';
  const source = 'config-file';
  return new ConfigurationError({ code, exitCode, field: 'config', message, source });
}

describe('revo server command line', () => {
  it('discovers the server group, its subcommands, and every start option', async () => {
    const root = await CliScenario.runIsolated(['--help']);
    const group = await CliScenario.runIsolated(['server', '--help']);
    const start = await CliScenario.runIsolated(['server', 'start', '--help']);

    for (const [result, texts] of [
      [root, ['server']],
      [group, ['Usage: revo server', 'start', 'status', 'stop', 'logs']],
      [start, START_OPTIONS.map(([usage]) => usage)],
    ] as const) {
      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      for (const text of texts) {
        expect(result.stdout).toContain(text);
      }
    }
  });

  it('prints the exact group usage for a bare server command', async () => {
    expect(await CliScenario.runIsolated(['server'])).toEqual({
      exitCode: 2,
      signal: null,
      stderr: `Usage: revo server <start|status|stop|logs>\nRun 'revo server <command> --help' for options.\n`,
      stdout: '',
    });
  });

  it('exposes only the lifecycle log options', async () => {
    const result = await CliScenario.runIsolated(['server', 'logs', '--help']);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    for (const option of [
      '--channel <channel>',
      '--config <path>',
      '--data-dir <path>',
      '--follow',
      '--log-dir <path>',
    ]) {
      expect(result.stdout).toContain(option);
    }
    for (const option of ['--host', '--port', '--json', '--tail', '--open']) {
      expect(result.stdout).not.toContain(option);
    }
  });

  it.each([
    {
      args: ['server', 'bogus'],
      stderr: /^error: too many arguments for 'server'\. Expected 0 arguments but got 1\./u,
    },
    { args: ['server', 'start', '--unknown'], stderr: /^error: unknown option '--unknown'/u },
    { args: ['server', 'start', '--port'], stderr: /option '--port <port>' argument missing/u },
    { args: ['server', 'start', 'extra'], stderr: /^error: too many arguments for 'start'/u },
    { args: ['server', 'status', '--port', '3210'], stderr: /^error: unknown option '--port'/u },
    { args: ['server', 'status', '--config', '/c.json'], stderr: /unknown option '--config'/u },
    { args: ['server', 'status', 'extra'], stderr: /^error: too many arguments for 'status'/u },
    { args: ['server', 'stop', '--data-dir', '/d'], stderr: /unknown option '--data-dir'/u },
    { args: ['server', 'stop', 'extra'], stderr: /^error: too many arguments for 'stop'/u },
    { args: ['server', 'start', '--port', '0'], stderr: /^Invalid configuration field port/u },
    { args: ['server', 'start', '--channel', 'x'], stderr: /configuration field channel/u },
    { args: ['server', 'start', '--host', ''], stderr: /^Invalid configuration field host/u },
    { args: ['server', 'start', '--startup-timeout', 'x'], stderr: /field startupTimeout/u },
    { args: ['server', 'logs', '--host', '127.0.0.1'], stderr: /unknown option '--host'/u },
    { args: ['server', 'logs', '--json'], stderr: /unknown option '--json'/u },
    { args: ['server', 'logs', '--tail', '10'], stderr: /unknown option '--tail'/u },
  ])('rejects $args as a usage failure', async ({ args, stderr }) => {
    const result = await CliScenario.runIsolated(args);

    expect(result).toMatchObject({ exitCode: 2, stdout: '' });
    expect(result.stderr).toMatch(stderr);
    expect(result.stderr).not.toMatch(/\n\s+at |NestFactory|\[Nest\]/i);
  });

  it('maps unreadable and malformed configuration files to usage failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-config-'));
    try {
      const malformed = join(root, 'malformed.json');
      await writeFile(malformed, '{ not json', 'utf8');
      const cfg = (p: string) => CliScenario.runIsolated(['server', 'start', '--config', p]);

      const unreadable = 'Unable to read the configuration file.\n';
      const usage = { exitCode: 2, stdout: '' };
      const absent = await cfg(join(root, 'absent.json'));
      const invalid = await cfg(malformed);

      expect(absent).toMatchObject({ ...usage, stderr: unreadable });
      expect(invalid).toMatchObject({ ...usage, stderr: 'Invalid configuration file JSON.\n' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('explains a real failed start with the logged reason, the log path, and its tail', async () => {
    const password = 'p@ss/word-1234';
    const result = await CliScenario.runIsolated([
      'server',
      'start',
      '--database-url',
      `postgresql://revo:${encodeURIComponent(password)}@127.0.0.1:9/revo`,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(
      /Server start failed\.\nServer log: \/[^\n]+\/server\.log\nLast \d+ log lines:\n--- Revo server start /u,
    );
    expect(result.stderr).toMatch(/ERROR \[ServerOwner\] Server start failed: the database/u);
    expect(result.stderr).not.toContain('p@ss');
    expect(result.stderr).not.toContain(encodeURIComponent(password));
  });

  it('reports an isolated home as stopped without starting a server', async () => {
    const status = await CliScenario.runIsolated(['server', 'status']);
    const stop = await CliScenario.runIsolated(['server', 'stop']);

    expect(status).toEqual({ exitCode: 0, signal: null, stderr: '', stdout: reported('stopped') });
    expect(stop).toEqual({ exitCode: 0, signal: null, stderr: '', stdout: ALREADY_STOPPED });
  });
});

describe('server command presentation', () => {
  it.each<{ code: number; err: string; out: string; outcome: ServerLaunchResult }>([
    { code: 0, err: '', out: 'Server started at http://127.0.0.1:3210.\n', outcome: STARTED },
    { code: 0, err: '', out: 'Server is already running.\n', outcome: serverStatus('running') },
    { code: 1, err: refused('starting'), out: '', outcome: serverStatus('starting') },
    { code: 1, err: refused('stopping'), out: '', outcome: serverStatus('stopping') },
    { code: 1, err: refused('failed'), out: '', outcome: serverStatus('failed') },
    { code: 1, err: NO_START, out: '', outcome: serverStatus('unknown') },
    { code: 1, err: NO_START, out: '', outcome: serverStatus('missing') },
    { code: 1, err: 'Server did not start.\n', out: '', outcome: serverStatus('stopped') },
  ])('presents a $outcome.kind launch outcome', async ({ code, err, out, outcome }) => {
    const result = await run(['server', 'start'], { launch: async () => outcome });

    expect(result).toMatchObject({ exitCode: code, stderr: err, stdout: out });
    expect(result.listeners).toEqual(NO_LISTENERS);
    expect([result.resolves, result.reads]).toEqual([[], []]);
  });

  it.each<InspectRow>([
    { calls: 0, cmd: 'status', code: 0, err: '', kind: 'running', out: reported('running') },
    { calls: 0, cmd: 'status', code: 0, err: '', kind: 'starting', out: reported('starting') },
    { calls: 0, cmd: 'status', code: 0, err: '', kind: 'stopping', out: reported('stopping') },
    { calls: 0, cmd: 'status', code: 0, err: '', kind: 'stopped', out: reported('stopped') },
    { calls: 0, cmd: 'status', code: 1, err: reported('failed'), kind: 'failed', out: '' },
    { calls: 0, cmd: 'status', code: 1, err: `${UNAVAILABLE}.\n`, kind: 'unknown', out: '' },
    { calls: 0, cmd: 'status', code: 1, err: `${UNAVAILABLE}.\n`, kind: 'missing', out: '' },
    { calls: 0, cmd: 'stop', code: 0, err: '', kind: 'stopped', out: ALREADY_STOPPED },
    { calls: 0, cmd: 'stop', code: 1, err: NO_STOP, kind: 'unknown', out: '' },
    { calls: 0, cmd: 'stop', code: 1, err: NO_STOP, kind: 'missing', out: '' },
    { calls: 1, cmd: 'stop', code: 0, err: '', kind: 'running', out: STOPPED },
    { calls: 1, cmd: 'stop', code: 0, err: '', kind: 'starting', out: STOPPED },
    { calls: 1, cmd: 'stop', code: 0, err: '', kind: 'stopping', out: STOPPED },
    { calls: 1, cmd: 'stop', code: 0, err: '', kind: 'failed', out: STOPPED },
  ])('presents $kind for revo server $cmd', async ({ calls, cmd, code, err, kind, out }) => {
    const result = await run(['server', cmd], { status: serverStatus(kind) });

    expect(result).toMatchObject({ exitCode: code, stderr: err, stdout: out });
    expect(result.resolves.map((input) => input.flags)).toEqual([{}]);
    expect(result.reads).toEqual([FIXTURE_DATA_DIR]);
    expect(result.launches).toEqual([]);
    expect(result.stops).toEqual(calls === 1 ? [STOP_CALL] : []);
  });

  it('reports an unconfirmed stop exactly once', async () => {
    const result = await run(['server', 'stop'], {
      status: serverStatus('running'),
      stop: { kind: 'unconfirmed', ownership: 'retained' },
    });

    expect(result).toMatchObject({
      exitCode: 1,
      stderr: 'Server stop could not be confirmed.\n',
      stdout: '',
    });
    expect(result.stops).toEqual([STOP_CALL]);
  });
});

describe('server command requests and failures', () => {
  it.each([['--progress'], ['--progress='], ['--progress=human'], ['--progress=secret']])(
    'rejects invalid progress arguments %s before launch',
    async (...args) => {
      const result = await run(['server', 'start', ...args]);
      expect(result).toMatchObject({ exitCode: 2, stdout: '', launches: [] });
      expect(result.stderr).not.toContain('secret');
    },
  );

  it('streams domain JSONL without the text summary or leaking progress into configuration', async () => {
    const operation = new ProgressOperation({ operationId: 'a'.repeat(32), now: () => 0 });
    const events = [operation.start('server-start'), operation.ready({ url: STARTED.url })];
    const result = await run(['server', 'start', '--progress=jsonl', '--port', '3300'], {
      launch: async (request) => {
        await events.reduce<Promise<void>>(
          (pending, event) => pending.then(() => event && request.onProgress?.(event)),
          Promise.resolve(),
        );
        return STARTED;
      },
    });
    expect(result).toMatchObject({ exitCode: 0, stderr: '', listeners: NO_LISTENERS });
    expect(result.launches).toHaveLength(1);
    expect(result.launches[0]?.flags).toEqual({ port: '3300' });
    expect(
      result.stdout
        .trimEnd()
        .split('\n')
        .map((line) => parseProgressEvent(JSON.parse(line))),
    ).toEqual(events);
  });

  it.each([
    { label: 'fresh', outcome: STARTED },
    { label: 'reused', outcome: serverStatus('running') },
  ])('exits zero for a $label running server when JSONL output breaks', async ({ outcome }) => {
    const operation = new ProgressOperation({ operationId: 'a'.repeat(32), now: () => 0 });
    const result = await run(['server', 'start', '--progress=jsonl'], {
      progressOutput: 'broken',
      launch: async (request) => {
        const event = operation.start('server-start');
        await Promise.resolve(event && request.onProgress?.(event)).catch(() => undefined);
        return outcome;
      },
    });

    expect(result).toMatchObject({ exitCode: 0, stderr: '', listeners: NO_LISTENERS });
  });

  it('resolves only the selected lifecycle log configuration', async () => {
    const result = await ServerCommandScenario.run([
      'server',
      'logs',
      '--channel',
      'alpha',
      '--config',
      '/fixture/custom.json',
      '--data-dir',
      '/fixture/custom-data',
      '--log-dir',
      '/fixture/custom-logs',
    ]);

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: '',
      stdout: 'No server lifecycle logs found.\n',
    });
    expect(result.resolves[0]?.flags).toEqual({
      channel: 'alpha',
      config: '/fixture/custom.json',
      dataDir: '/fixture/custom-data',
      logDir: '/fixture/custom-logs',
    });
  });

  it('sends one launch request from flags, ambient state, and package metadata', async () => {
    process.env.REVO_COMMAND_SNAPSHOT = 'present';
    try {
      const result = await run(['server', 'start', ...START_ARGV], {
        launch: started,
        version: '9.8.7',
      });
      const [request] = result.launches;

      expect(result.launches).toHaveLength(1);
      expect(request?.flags).toEqual(START_FLAGS);
      expect(request?.env).toEqual({ ...process.env });
      expect(request?.env).not.toBe(process.env);
      expect(request?.homeDir).toBe(homedir());
      expect(request?.packageVersion).toBe('9.8.7');
      expect(request?.platform).toBe(process.platform);
      expect(request?.signal.aborted).toBe(false);
      expect(request).not.toHaveProperty('wrapperChannel');
      expect(result.resolves).toEqual([]);
    } finally {
      delete process.env.REVO_COMMAND_SNAPSHOT;
    }
  });

  it('omits absent configuration flags instead of sending Commander defaults', async () => {
    const result = await run(['server', 'start', '--port', '3300'], { launch: started });

    expect(result.launches[0]?.flags).toEqual({ port: '3300' });
  });

  it.each(['start', 'status', 'stop', 'logs'] as const)(
    'refuses server %s on win32',
    async (cmd) => {
      const result = await run(['server', cmd], { platform: 'win32' });

      expect(result).toMatchObject({
        exitCode: 1,
        stderr: 'Server commands are unsupported on this platform.\n',
        stdout: '',
      });
      expect([result.launches, result.resolves, result.reads]).toEqual([[], [], []]);
    },
  );

  it.each([
    {
      error: launchError('REVO_ACTIVATION_STATE_INCOMPATIBLE'),
      stderr:
        'Installation activation format is incompatible. Keep your data and reinstall into a new installation directory.\n',
    },
    { error: launchError('START_BUSY'), stderr: 'Server start is busy.\n' },
    { error: launchError('START_CANCELLED'), stderr: CANCELLED },
    { error: new ManagedProcessError('revo.process.cancelled', 'cancelled'), stderr: CANCELLED },
    { error: launchError('START_FAILED'), stderr: FAILED },
    { error: launchError('START_FAILED', 'completed'), stderr: FAILED },
    { error: launchError('START_FAILED', 'retained'), stderr: RETAINED },
    { error: launchError('START_OUTCOME_UNKNOWN'), stderr: OUTCOME },
    { error: launchError('START_OUTCOME_UNKNOWN', 'unconfirmed'), stderr: UNCONFIRMED },
  ])('diagnoses a launch failure as $stderr', async ({ error, stderr }) => {
    const result = await run(['server', 'start'], { launch: () => Promise.reject(error) });

    expect(result).toMatchObject({ exitCode: 1, stderr, stdout: '' });
  });

  it.each([
    { failure: configurationFailure(1, 'Unable to read the configuration file.') },
    { failure: configurationFailure(2, 'Invalid configuration file JSON.') },
  ])('maps a $failure.code failure to a usage exit code', async ({ failure }) => {
    const rejected = () => Promise.reject(failure);
    const results = [
      await run(['server', 'start'], { launch: rejected }),
      await run(['server', 'status'], { resolve: rejected }),
      await run(['server', 'stop'], { resolve: rejected }),
    ];

    for (const result of results) {
      expect(result).toMatchObject({ exitCode: 2, stderr: `${failure.message}\n`, stdout: '' });
    }
  });

  it.each([
    { aborted: true, raise: 'SIGINT' as const, stderr: 'Server did not start.\n' },
    { aborted: true, raise: 'SIGTERM' as const, stderr: 'Server did not start.\n' },
    { aborted: false, raise: undefined, stderr: FAILED },
  ])('stays silent while pending and cleans up listeners for $raise', async (row) => {
    const result = await run(['server', 'start'], {
      launch: async ({ signal }) =>
        signal.aborted ? serverStatus('stopped') : Promise.reject(launchError('START_FAILED')),
      ...(row.raise === undefined ? {} : { raise: row.raise }),
    });

    expect(result.pending).toEqual(SILENT_PENDING);
    expect(result.listeners).toEqual(NO_LISTENERS);
    expect(result.launches[0]?.signal.aborted).toBe(row.aborted);
    expect(result).toMatchObject({ exitCode: 1, stderr: row.stderr, stdout: '' });
  });
});

describe('readable server start failures', () => {
  const logs: ServerLogFixture[] = [];
  afterEach(async () => {
    await Promise.all(logs.splice(0).map((log) => log.dispose()));
  });
  const fixture = async () => {
    const log = await ServerLogFixture.create();
    logs.push(log);
    return log;
  };
  const failedStart = (log: ServerLogFixture, error: Error) =>
    run(['server', 'start', '--log-dir', log.configuration.logDir], {
      resolve: async () => log.configuration,
      launch: () => Promise.reject(error),
    });

  it('prints the reason, the server log path, and the last 40 lines of the failed start', async () => {
    const log = await fixture();
    const lines = Array.from({ length: 60 }, (_, index) => `core output ${String(index + 1)}`);
    await log.startAttempt([...lines.slice(0, -1), 'ERROR [CoreHost] Core migration failed']);

    const result = await failedStart(log, launchError('START_FAILED', 'completed'));

    expect(result.exitCode).toBe(1);
    expect(result.resolves.map((input) => input.flags)).toEqual([
      { logDir: log.configuration.logDir },
    ]);
    expect(result.stderr).toBe(
      [
        'Server start failed.',
        `Server log: ${await log.path()}`,
        'Last 40 log lines:',
        ...lines.slice(20, 59),
        'ERROR [CoreHost] Core migration failed',
        '',
      ].join('\n'),
    );
  });

  it('shows only the lines of the latest start attempt', async () => {
    const log = await fixture();
    await log.startAttempt(['previous attempt failure']);
    await log.startAttempt(['Database start failed: connection refused']);

    const result = await failedStart(log, launchError('START_OUTCOME_UNKNOWN'));

    expect(result.stderr).toContain('Server start outcome is unknown.\n');
    expect(result.stderr).toContain('Database start failed: connection refused');
    expect(result.stderr).not.toContain('previous attempt failure');
    expect(result.stderr).toMatch(/Last 2 log lines:\n--- Revo server start \S+ ---\n/u);
  });

  it('prints only the diagnostic when no server log exists', async () => {
    const log = await fixture();

    const result = await failedStart(log, launchError('START_FAILED'));

    expect(result).toMatchObject({ exitCode: 1, stderr: FAILED, stdout: '' });
  });

  it.each(['START_BUSY', 'START_CANCELLED'])(
    'keeps the %s diagnostic without logs',
    async (code) => {
      const log = await fixture();
      await log.startAttempt(['unrelated output']);

      const result = await failedStart(log, launchError(code));

      expect(result.stderr).not.toContain('unrelated output');
      expect(result.stderr).not.toContain('Server log:');
    },
  );
});

describe('JSONL output backpressure', () => {
  it('waits for the write callback and drain before accepting the next event', async () => {
    const scenario = new ProgressOutputScenario();
    try {
      let settled = false;
      const pending = scenario.write().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      scenario.drain();
      await pending;
      expect(scenario.lines).toHaveLength(1);
      expect(scenario.listeners().drain).toBe(0);
    } finally {
      scenario.close();
    }
    expect(scenario.listeners()).toEqual({ error: 0, drain: 0 });
  });

  it('rejects later events after a stream error and releases its listeners', async () => {
    const scenario = new ProgressOutputScenario();
    try {
      const pending = scenario.write();
      scenario.fail();
      await expect(pending).rejects.toMatchObject({ code: 'START_PROGRESS_OUTPUT_FAILED' });
      await new Promise((resolve) => setImmediate(resolve));
      await expect(scenario.write()).rejects.toMatchObject({
        code: 'START_PROGRESS_OUTPUT_FAILED',
      });
      expect(scenario.lines).toHaveLength(1);
      expect(scenario.listeners().drain).toBe(0);
    } finally {
      scenario.close();
    }
    expect(scenario.listeners()).toEqual({ error: 0, drain: 0 });
    await scenario.destroy();
  });

  it('keeps a slow write pending instead of failing it on a timer', async () => {
    vi.useFakeTimers();
    const scenario = new ProgressOutputScenario();
    try {
      let outcome = 'pending';
      const slow = scenario.write().then(
        () => (outcome = 'written'),
        () => (outcome = 'failed'),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(outcome).toBe('pending');
      scenario.drain();
      await slow;
      expect(outcome).toBe('written');
      await expect(scenario.writeDrained()).resolves.toBeUndefined();
      expect(scenario.lines).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      scenario.close();
    }
    expect(scenario.listeners()).toEqual({ error: 0, drain: 0 });
  });

  it('settles a pending write on close and guards a late EPIPE until the stream closes', async () => {
    const scenario = new ProgressOutputScenario();
    try {
      const pending = scenario.write();
      scenario.close();
      await expect(pending).rejects.toMatchObject({ code: 'START_PROGRESS_OUTPUT_FAILED' });
      expect(scenario.listeners()).toEqual({ error: 1, drain: 0 });
      scenario.fail();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      await scenario.destroy();
    }
    expect(scenario.listeners()).toEqual({ error: 0, drain: 0 });
  });
});
