import { fork } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

import { describe, expect, it } from 'vitest';

import {
  CORE_HOST_PROTOCOL,
  parseCoreHostMessage,
} from '../../src/core-host/core-child-protocol.js';
import { CoreChildRunner } from '../../src/core-host/core-child-runner.js';
import { ManagedProcessService } from '../../src/processes/managed-process.service.js';
import {
  CoreChildEntryScenario,
  CoreChildScenario,
  DeferredCoreRuntimeService,
} from '../support/core-host/core-host-scenario.js';
import { ClusterFixture } from '../support/postgres/postgres-readiness-scenario.js';

const start = {
  protocol: CORE_HOST_PROTOCOL,
  type: 'start',
  databaseUrl: 'postgresql://localhost/revo',
  temporaryWorkingDirectoryRoot: '/tmp/revo-work',
  agentWorkspaceDirectory: '/tmp/revo-sessions',
  host: '127.0.0.1',
  port: 0,
} as const;

describe('Core child runtime', () => {
  it('exits before hello without loading the Core runner', async () => {
    const scenario = new CoreChildEntryScenario();
    scenario.start();
    scenario.disconnect();
    await scenario.settled();
    expect(scenario.loadCalls).toBe(0);
    expect(scenario.sent).toEqual([]);
    expect(scenario.exitCodes).toEqual([0]);
  });

  it('loads once after hello and forwards buffered start only after booted', async () => {
    const scenario = new CoreChildEntryScenario();
    scenario.start();
    scenario.deferBootedSend();
    scenario.hello();
    scenario.hello();
    scenario.message(start);
    scenario.message({ protocol: CORE_HOST_PROTOCOL, type: 'shutdown' });
    expect(scenario.loadCalls).toBe(1);
    expect(scenario.received).toEqual([]);
    scenario.resolveLoad();
    await scenario.settled();
    scenario.message(start);
    expect(scenario.received).toEqual([]);
    scenario.resolveBootedSend();
    await scenario.settled();
    expect(scenario.events).toEqual([
      'sent:booted',
      'received:start',
      'received:shutdown',
      'received:start',
    ]);

    const disconnected = new CoreChildEntryScenario();
    disconnected.start();
    disconnected.deferBootedSend();
    disconnected.hello();
    disconnected.message(start);
    disconnected.resolveLoad();
    await disconnected.settled();
    disconnected.disconnect();
    disconnected.resolveBootedSend();
    await disconnected.settled();
    expect(disconnected.sent).toEqual([]);
    expect(disconnected.received).toEqual([]);
    expect(disconnected.exitCodes).toEqual([0]);
  });

  it('does not create a runner or send after disconnect during its import', async () => {
    const scenario = new CoreChildEntryScenario();
    scenario.start();
    scenario.hello();
    scenario.message(start);
    scenario.disconnect();
    scenario.resolveLoad();
    await scenario.settled();
    expect(scenario.sent).toEqual([]);
    expect(scenario.received).toEqual([]);
    expect(scenario.runnerConstructorCalls).toBe(0);
    expect(scenario.runnerDisconnectCalls).toBe(0);
    expect(scenario.exitCodes).toEqual([0]);
  });

  it('reports a runner load rejection without exposing its error', async () => {
    const scenario = new CoreChildEntryScenario();
    scenario.start();
    scenario.hello();
    scenario.rejectLoad();
    await scenario.settled();
    expect(scenario.sent).toEqual([
      { protocol: CORE_HOST_PROTOCOL, type: 'failed', code: 'CORE_HOST_FAILED' },
    ]);
    expect(JSON.stringify(scenario.sent)).not.toContain('SECRET');
    expect(scenario.exitCodes).toEqual([1]);
    expect(scenario.disconnectCalls).toBe(1);
  });

  it('accepts an OS-assigned listen port only on start', () => {
    const scenario = new CoreChildScenario();
    new CoreChildRunner(scenario, new DeferredCoreRuntimeService()).receive(start);
    expect(scenario.finished).toBeUndefined();
  });

  it('rejects malformed and duplicate start messages with safe output', async () => {
    const scenario = new CoreChildScenario();
    const runner = new CoreChildRunner(scenario, new DeferredCoreRuntimeService());
    runner.receive({ ...start, databaseUrl: '' });
    await scenario.settled();
    expect(scenario.sent).toEqual([
      { protocol: CORE_HOST_PROTOCOL, type: 'failed', code: 'CORE_HOST_FAILED' },
    ]);
    expect(scenario.finished).toBe(2);

    const duplicate = new CoreChildScenario();
    const duplicateService = new DeferredCoreRuntimeService();
    const duplicateRunner = new CoreChildRunner(duplicate, duplicateService);
    duplicateRunner.receive(start);
    duplicateRunner.receive(start);
    duplicateService.resolveFactory();
    await duplicate.settled();
    expect(duplicate.finished).toBe(2);
  });

  it('stops admission during a late factory and closes its result exactly once', async () => {
    const service = new DeferredCoreRuntimeService();
    const scenario = new CoreChildScenario();
    const runner = new CoreChildRunner(scenario, service);
    runner.receive(start);
    runner.receive({ protocol: CORE_HOST_PROTOCOL, type: 'shutdown' });
    const runtime = service.resolveFactory();
    await scenario.settled();
    expect(runtime.closeCalls).toBe(1);
    expect(runtime.listenCalls).toBe(0);
    expect(scenario.sent.some((message) => message.type === 'listening')).toBe(false);
    expect(scenario.finished).toBe(0);
  });

  it('drains ordered stage delivery before publishing the listener', async () => {
    const service = new DeferredCoreRuntimeService();
    const scenario = new CoreChildScenario();
    const runner = new CoreChildRunner(scenario, service);
    runner.receive(start);
    service.resolveFactory();
    await scenario.untilListening();
    expect(scenario.sent.map((message) => message.type)).toEqual([
      'stage',
      'stage',
      'stage',
      'stage',
      'listening',
    ]);
    runner.receive({ protocol: CORE_HOST_PROTOCOL, type: 'shutdown' });
    await scenario.settled();
  });

  it.each(['factory', 'prepare'] as const)(
    'turns a secret %s rejection into a bounded safe failure',
    async (failure) => {
      const service = new DeferredCoreRuntimeService();
      const scenario = new CoreChildScenario();
      const runner = new CoreChildRunner(scenario, service);
      runner.receive(start);
      if (failure === 'factory') {
        service.rejectFactory();
      } else {
        service.resolveFactory({ prepareRejects: true });
      }
      await expect(scenario.settledWithin()).resolves.toBeUndefined();
      expect(scenario.finished).toBe(1);
      expect(scenario.finishCalls).toBe(1);
      expect(scenario.sent.at(-1)).toEqual({
        protocol: CORE_HOST_PROTOCOL,
        type: 'failed',
        code: 'CORE_HOST_FAILED',
      });
      expect(JSON.stringify(scenario.sent)).not.toContain('SECRET');
    },
  );

  it('closes once and finishes nonzero when ordered stage delivery fails', async () => {
    const service = new DeferredCoreRuntimeService();
    const scenario = new CoreChildScenario();
    scenario.failSending();
    const runner = new CoreChildRunner(scenario, service);
    runner.receive(start);
    const runtime = service.resolveFactory();
    await expect(scenario.settledWithin()).resolves.toBeUndefined();
    expect(runtime.closeCalls).toBe(1);
    expect(scenario.finished).toBe(1);
    expect(scenario.sent.some((message) => message.type === 'listening')).toBe(false);
  });

  it.each(['factory', 'prepare'] as const)(
    'reports a close rejection after shutdown during pending %s',
    async (transition) => {
      const service = new DeferredCoreRuntimeService();
      const scenario = new CoreChildScenario();
      const runner = new CoreChildRunner(scenario, service);
      runner.receive(start);
      if (transition === 'factory') {
        runner.receive({ protocol: CORE_HOST_PROTOCOL, type: 'shutdown' });
      }
      const runtime = service.resolveFactory({
        closeRejects: true,
        prepareHeld: transition === 'prepare',
      });
      if (transition === 'prepare') {
        await until(() => runtime.prepareCalls === 1);
        runner.receive({ protocol: CORE_HOST_PROTOCOL, type: 'shutdown' });
        runtime.releasePrepare();
      }
      await expect(scenario.settledWithin()).resolves.toBeUndefined();
      expect(runtime.closeCalls).toBe(1);
      expect(scenario.finished).toBe(1);
      expect(JSON.stringify(scenario.sent)).not.toContain('SECRET');
    },
  );

  it('reports a close rejection after a ready runtime shuts down', async () => {
    const service = new DeferredCoreRuntimeService();
    const scenario = new CoreChildScenario();
    const runner = new CoreChildRunner(scenario, service);
    runner.receive(start);
    const runtime = service.resolveFactory({ closeRejects: true });
    await scenario.untilListening();
    runner.receive({ protocol: CORE_HOST_PROTOCOL, type: 'shutdown' });
    await expect(scenario.settledWithin()).resolves.toBeUndefined();
    expect(runtime.closeCalls).toBe(1);
    expect(scenario.finished).toBe(1);
    expect(scenario.sent.at(-1)?.type).toBe('failed');
  });

  it.each(['prepare', 'listen'] as const)(
    'does not publish a late listener when shutdown holds %s',
    async (transition) => {
      const service = new DeferredCoreRuntimeService();
      const scenario = new CoreChildScenario();
      const runner = new CoreChildRunner(scenario, service);
      runner.receive(start);
      const runtime = service.resolveFactory({
        prepareHeld: transition === 'prepare',
        listenHeld: transition === 'listen',
      });
      await until(() =>
        transition === 'prepare' ? runtime.prepareCalls === 1 : runtime.listenCalls === 1,
      );
      runner.receive({ protocol: CORE_HOST_PROTOCOL, type: 'shutdown' });
      runtime.releasePrepare();
      runtime.releaseListen();
      await expect(scenario.settledWithin()).resolves.toBeUndefined();
      expect(runtime.closeCalls).toBe(1);
      expect(scenario.sent.some((message) => message.type === 'listening')).toBe(false);
      expect(scenario.finished).toBe(0);
    },
  );

  it('handles early IPC disconnect while the factory is pending', async () => {
    const service = new DeferredCoreRuntimeService();
    const scenario = new CoreChildScenario();
    const runner = new CoreChildRunner(scenario, service);
    runner.receive(start);
    const disconnected = runner.disconnected();
    const runtime = service.resolveFactory();
    await expect(disconnected).resolves.toBeUndefined();
    expect(runtime.closeCalls).toBe(1);
    expect(scenario.finishCalls).toBe(1);
    expect(scenario.sent.some((message) => message.type === 'listening')).toBe(false);
  });
});

describe('published Core child process', () => {
  it('migrates new and existing databases, serves GraphQL, and closes its listener', async () => {
    const cluster = await ClusterFixture.start('scram');
    const root = await mkdtemp('/tmp/revo-core-host-');
    let first: Awaited<ReturnType<typeof startActualCore>> | undefined;
    let existing: Awaited<ReturnType<typeof startActualCore>> | undefined;
    try {
      first = await startActualCore(cluster.connectionUrl(), root);
      expect(first.stages).toEqual([
        'application-database-migrations:started',
        'application-database-migrations:completed',
        'dbos-system-migrations:started',
        'dbos-system-migrations:completed',
        'application-bootstrap:started',
        'application-bootstrap:completed',
        'api-readiness:started',
        'api-readiness:completed',
      ]);
      await expect(graphql(first.url)).resolves.toEqual({ data: { __typename: 'Query' } });
      await first.stop();
      await expect(fetch(`${first.url}/graphql`)).rejects.toBeInstanceOf(TypeError);

      existing = await startActualCore(cluster.connectionUrl(), root);
      await expect(graphql(existing.url)).resolves.toEqual({ data: { __typename: 'Query' } });
      await existing.stop();
    } finally {
      await existing?.cleanup();
      await first?.cleanup();
      await cluster.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('bounds and redacts a real subprocess startup failure', async () => {
    const root = await mkdtemp('/tmp/revo-core-host-failure-');
    const processes = new ManagedProcessService();
    const child = await startCoreChild(processes, root);
    const stdout = captureBounded(child.stdout);
    const stderr = captureBounded(child.stderr);
    const messages: unknown[] = [];
    child.subscribe?.((message) => messages.push(message));
    const deadline = Date.now() + 15_000;
    try {
      await child.send?.({ protocol: CORE_HOST_PROTOCOL, type: 'hello' });
      await waitFor(messages, 'booted', deadline);
      await child.send?.({
        ...start,
        databaseUrl: 'postgresql://user:SECRET-marker@127.0.0.1:1/missing',
        temporaryWorkingDirectoryRoot: join(root, 'work'),
        agentWorkspaceDirectory: join(root, 'sessions'),
      });
      await waitFor(messages, 'failed', deadline);
      const completion = await withinDeadline(child.completion, deadline);
      await withinDeadline(Promise.all([stdout.completed, stderr.completed]), deadline);
      expect(completion.exitCode).toBe(1);
      expect(JSON.stringify(messages)).not.toContain('SECRET-marker');
      expect(`${stdout.text()}${stderr.text()}`).not.toContain('SECRET-marker');
      expect(stdout.bytes()).toBeLessThanOrEqual(8192);
      expect(stderr.bytes()).toBeLessThanOrEqual(8192);
      expect(stdout.failed() || stderr.failed()).toBe(false);
    } finally {
      try {
        await processes.stop(child, { graceMs: 500, killWaitMs: 2_000 }).catch(() => undefined);
        await within(child.completion, 3_000);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it('handles a real parent disconnect before the entrypoint finishes booting', async () => {
    const root = await mkdtemp('/tmp/revo-core-host-disconnect-');
    const home = join(root, 'home');
    await mkdir(home, { mode: 0o700 });
    const child = fork(join(process.cwd(), 'dist/bin/revo-core-host.js'), [], {
      cwd: process.cwd(),
      env: childEnvironment(home),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const stdout = captureBounded(child.stdout ?? undefined);
    const stderr = captureBounded(child.stderr ?? undefined);
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    try {
      child.disconnect();
      const state = () =>
        `exit=${String(child.exitCode)} signal=${String(child.signalCode)} stdoutDrained=${String(stdout.drained())} stderrDrained=${String(stderr.drained())}`;
      const result = await within(completion, 5_000, 'early-disconnect exit', state);
      await within(
        Promise.all([stdout.completed, stderr.completed]),
        1_000,
        'early-disconnect stream drain',
        state,
      );
      expect(result).toEqual({ code: 0, signal: null });
      expect(stdout.failed() || stderr.failed()).toBe(false);
      expect(`${stdout.text()}${stderr.text()}`).not.toContain('ERR_IPC_DISCONNECTED');
    } finally {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
        await within(
          completion,
          1_000,
          'early-disconnect cleanup exit',
          () => `exit=${String(child.exitCode)} signal=${String(child.signalCode)}`,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 10_000);
});

async function startActualCore(databaseUrl: string, root: string) {
  const processes = new ManagedProcessService();
  const child = await startCoreChild(processes, root);
  child.stdout?.resume();
  child.stderr?.resume();
  const messages: unknown[] = [];
  child.subscribe?.((message) => messages.push(message));
  const cleanup = async () => {
    await processes.stop(child, { graceMs: 500, killWaitMs: 2_000 }).catch(() => undefined);
    await within(child.completion, 3_000);
  };
  try {
    await child.send?.({ protocol: CORE_HOST_PROTOCOL, type: 'hello' });
    await waitFor(messages, 'booted');
    await child.send?.({
      ...start,
      databaseUrl,
      temporaryWorkingDirectoryRoot: join(root, 'work'),
      agentWorkspaceDirectory: join(root, 'sessions'),
    });
    const listening = await waitFor(messages, 'listening');
    if (listening.type !== 'listening') {
      throw new Error('Core child did not listen');
    }
    return {
      url: listening.url,
      stages: messages.flatMap((message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'stage'
          ? [
              `${String('stage' in message && message.stage)}:${String('status' in message && message.status)}`,
            ]
          : [],
      ),
      stop: async () => {
        await child.send?.({ protocol: CORE_HOST_PROTOCOL, type: 'shutdown' });
        expect(await within(child.completion, 3_000)).toEqual({ exitCode: 0, signal: null });
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function startCoreChild(processes: ManagedProcessService, root: string) {
  const home = join(root, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  return processes.start({
    executable: process.execPath,
    args: [join(process.cwd(), 'dist/bin/revo-core-host.js')],
    cwd: process.cwd(),
    env: childEnvironment(home),
    ipc: true,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  });
}

async function waitFor(messages: unknown[], type: string, deadline = Date.now() + 30_000) {
  if (Date.now() >= deadline) {
    throw new Error(`Core child did not send ${type}`);
  }
  const message = messages.map(parseCoreHostMessage).find((candidate) => candidate?.type === type);
  if (message) {
    return message;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  return waitFor(messages, type, deadline);
}

const graphql = (url: string) =>
  fetch(`${url}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ __typename }' }),
  }).then((response) => response.json());

async function until(predicate: () => boolean, deadline = Date.now() + 250): Promise<void> {
  if (predicate()) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error('transition did not start');
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  await until(predicate, deadline);
}

function captureBounded(stream: NodeJS.ReadableStream | undefined) {
  const chunks: Buffer[] = [];
  let byteCount = 0;
  let retainedBytes = 0;
  let streamFailed = false;
  let streamDrained = stream === undefined;
  const completed = stream
    ? finished(stream).then(
        () => {
          streamDrained = true;
        },
        () => {
          streamFailed = true;
          streamDrained = true;
        },
      )
    : Promise.resolve();
  stream?.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += buffer.length;
    if (retainedBytes < 8192) {
      const retained = buffer.subarray(0, 8192 - retainedBytes);
      chunks.push(retained);
      retainedBytes += retained.length;
    }
  });
  return {
    bytes: () => byteCount,
    completed,
    drained: () => streamDrained,
    failed: () => streamFailed,
    text: () => Buffer.concat(chunks).subarray(0, 8192).toString('utf8'),
  };
}

function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  label = 'subprocess',
  state: () => string = () => 'state unavailable',
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not finish: ${state()}`)), milliseconds),
    ),
  ]);
}

function withinDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(new Error('subprocess deadline expired'));
  }
  return within(promise, remaining);
}

function childEnvironment(home: string) {
  return {
    HOME: home,
    LANG: 'C.UTF-8',
    LOGNAME: 'node',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    SHELL: '/bin/sh',
    USER: 'node',
  };
}
