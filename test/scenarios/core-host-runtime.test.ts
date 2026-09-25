import { fork } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CORE_HOST_PROTOCOL,
  parseCoreHostMessage,
} from '../../src/core-host/core-child-protocol.js';
import { CoreChildRunner } from '../../src/core-host/core-child-runner.js';
import { ManagedProcessService } from '../../src/processes/managed-process.service.js';
import type { ManagedProcessRequest } from '../../src/processes/managed-process.types.js';
import {
  CoreChildEntryScenario,
  CoreChildScenario,
  DeferredCoreRuntimeService,
} from '../support/core-host/core-host-scenario.js';
import { cleanupRegistered } from '../support/postgres/fixture-cleanup.js';
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

  it('closes the runtime before readiness when the Admin bundle is unavailable', async () => {
    vi.doMock('@revisium/revo-admin/runtime', () => ({
      getRevoAdminClientDirectory: () => '/tmp/revo-admin-missing-bundle',
    }));
    try {
      const service = new DeferredCoreRuntimeService();
      const runtime = service.resolveFactory();
      await expect(
        service.start(start, new AbortController().signal, () => undefined),
      ).rejects.toThrow('Revo Admin client assets are unavailable');
      expect(runtime.closeCalls).toBe(1);
      expect(runtime.prepareCalls).toBe(0);
      expect(runtime.listenCalls).toBe(0);
    } finally {
      vi.doUnmock('@revisium/revo-admin/runtime');
    }
  });
});

describe('published Core child process', () => {
  const clusters: ClusterFixture[] = [];
  afterEach(async () => {
    await cleanupRegistered(clusters, (cluster) => cluster.close());
  }, 20_000);

  it('migrates new and existing databases, serves GraphQL, and closes its listener', async () => {
    const cluster = ClusterFixture.create('scram');
    clusters.push(cluster);
    await cluster.start();
    const deadline = Date.now() + 75_000;
    const root = await mkdtemp('/tmp/revo-core-host-').catch(async (primary: unknown) => {
      await cluster.close().catch((error: unknown) => {
        throw new Error(
          `scenario cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: primary },
        );
      });
      throw primary;
    });
    const ownedCores: (() => Promise<void>)[] = [];
    const startCore = (label: string) =>
      startActualCore(cluster.connectionUrl(), root, label, deadline, ownedCores);
    let primary: unknown;
    try {
      const first = await startCore('new database');
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
      await expect(graphql(first.url, deadline, 'new database')).resolves.toEqual({
        data: { __typename: 'Query' },
      });
      await expect(
        boundedFetch(`${first.url}/dialogues`, deadline, 'new database admin', {
          headers: { accept: 'text/html' },
        }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        boundedFetch(`${first.url}/assets/index-CMjyOelg.js`, deadline, 'new database assets'),
      ).resolves.toMatchObject({ status: 200 });
      await first.stop();
      await expect(
        boundedFetch(`${first.url}/graphql`, deadline, 'new database post-shutdown'),
      ).rejects.toBeInstanceOf(TypeError);

      const existing = await startCore('existing database');
      await expect(graphql(existing.url, deadline, 'existing database')).resolves.toEqual({
        data: { __typename: 'Query' },
      });
      await existing.stop();
    } catch (error) {
      primary = error;
    }
    const failures: string[] = [];
    const record = async (operation: Promise<void>) => {
      try {
        await operation;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    };
    await Promise.all(ownedCores.reverse().map((terminate) => record(terminate())));
    const confirmedCoreTermination = failures.length === 0;
    await record(cluster.close());
    if (confirmedCoreTermination) {
      await record(rm(root, { recursive: true, force: true }));
    }
    if (failures.length > 0) {
      throw new Error(`scenario cleanup failed: ${failures.join('; ')}`, { cause: primary });
    }
    if (primary !== undefined) {
      throw primary;
    }
  }, 180_000);

  it('bounds and redacts a real subprocess startup failure', async () => {
    const root = await mkdtemp('/tmp/revo-core-host-failure-');
    const processes = new ManagedProcessService();
    const child = await startCoreChild(processes, root, { CHECKPOINT_DISABLE: '1' });
    const stdout = captureBounded(child.stdout);
    const stderr = captureBounded(child.stderr);
    const messages: unknown[] = [];
    let observedCompletion: Awaited<typeof child.completion> | undefined;
    void child.completion.then((completion) => {
      observedCompletion = completion;
    });
    child.subscribe?.((message) => messages.push(message));
    try {
      const startupFailureDeadline = Date.now() + 25_000;
      await withinDeadline(
        child.send?.({ protocol: CORE_HOST_PROTOCOL, type: 'hello' }) ??
          Promise.reject(new Error('Core child IPC unavailable')),
        startupFailureDeadline,
      );
      await withinDeadline(
        child.send?.({
          ...start,
          databaseUrl: 'postgresql://user:SECRET-marker@127.0.0.1:99999/missing',
          temporaryWorkingDirectoryRoot: join(root, 'work'),
          agentWorkspaceDirectory: join(root, 'sessions'),
        }) ?? Promise.reject(new Error('Core child IPC unavailable')),
        startupFailureDeadline,
      );
      await waitFor(messages, 'booted', startupFailureDeadline, () => observedCompletion);
      await waitFor(messages, 'failed', startupFailureDeadline, () => observedCompletion);
      const types = messages.map(parseCoreHostMessage).map((message) => message?.type);
      expect(types.indexOf('booted')).toBeLessThan(types.indexOf('failed'));
      const completion = await withinDeadline(child.completion, startupFailureDeadline);
      await withinDeadline(
        Promise.all([stdout.completed, stderr.completed]),
        startupFailureDeadline,
      );
      expect(completion.exitCode).toBe(1);
      expect(completion.signal).toBeNull();
      expect(JSON.stringify(messages)).not.toContain('SECRET-marker');
      expect(`${stdout.text()}${stderr.text()}`).not.toContain('SECRET-marker');
      expect(stdout.bytes()).toBeLessThanOrEqual(8192);
      expect(stderr.bytes()).toBeLessThanOrEqual(8192);
      expect(stdout.failed() || stderr.failed()).toBe(false);
    } finally {
      const cleanupDeadline = Date.now() + 6_000;
      await withinDeadline(
        processes.stop(child, { graceMs: 500, killWaitMs: 2_000 }),
        cleanupDeadline,
      );
      await withinDeadline(child.completion, cleanupDeadline);
      await withinDeadline(Promise.all([stdout.completed, stderr.completed]), cleanupDeadline);
      await rm(root, { recursive: true, force: true });
    }
  }, 35_000);

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

async function startActualCore(
  databaseUrl: string,
  root: string,
  label: string,
  deadline: number,
  ownedCores: (() => Promise<void>)[],
) {
  const processes = new ManagedProcessService();
  const controller = new AbortController();
  const remaining = Math.max(0, deadline - Date.now());
  const timer = setTimeout(() => controller.abort(), remaining);
  if (remaining === 0) {
    controller.abort();
  }
  const child = await startCoreChild(
    processes,
    root,
    {},
    {
      signal: controller.signal,
      graceMs: 500,
      killWaitMs: 2_000,
    },
  )
    .finally(() => clearTimeout(timer))
    .catch(() => {
      throw new Error(`${label} spawn failed`);
    });
  let completed: Awaited<typeof child.completion> | undefined;
  void child.completion.then((completion) => {
    completed = completion;
  });
  ownedCores.push(async () => {
    await processes.stop(child, { graceMs: 500, killWaitMs: 2_000 }).catch(() => undefined);
    await within(child.completion, 3_000, `${label} termination`, state);
  });
  child.stdout?.resume();
  child.stderr?.resume();
  const messages: unknown[] = [];
  child.subscribe?.((message) => messages.push(message));
  const state = () =>
    `${label} stages=${stageIds(messages).join(',')} exitCode=${String(completed?.exitCode)} signal=${String(completed?.signal)}`;
  const send = (message: object, phase: string) => {
    const operation = child.send?.(message);
    if (!operation) {
      return Promise.reject(new Error(`${label} ${phase} send unavailable: ${state()}`));
    }
    return withinDeadline(
      Promise.race([
        operation.catch(() => {
          throw new Error(`${label} ${phase} send failed: ${state()}`);
        }),
        child.completion.then(() => {
          throw new Error(`${label} exited during ${phase} send: ${state()}`);
        }),
      ]),
      deadline,
      `${label} ${phase} send`,
      state,
    );
  };
  await send({ protocol: CORE_HOST_PROTOCOL, type: 'hello' }, 'hello');
  await waitFor(messages, 'booted', deadline, () => completed, label);
  await send(
    {
      ...start,
      databaseUrl,
      temporaryWorkingDirectoryRoot: join(root, 'work'),
      agentWorkspaceDirectory: join(root, 'sessions'),
    },
    'start',
  );
  const listening = await waitFor(messages, 'listening', deadline, () => completed, label);
  if (listening.type !== 'listening') {
    throw new Error(`${label} did not listen: ${state()}`);
  }
  return {
    url: listening.url,
    stages: stageIds(messages),
    stop: async () => {
      await send({ protocol: CORE_HOST_PROTOCOL, type: 'shutdown' }, 'shutdown');
      expect(
        await withinDeadline(child.completion, deadline, `${label} shutdown exit`, state),
      ).toEqual({ exitCode: 0, signal: null });
    },
  };
}

const stageIds = (messages: readonly unknown[]) =>
  messages
    .map(parseCoreHostMessage)
    .flatMap((message) =>
      message?.type === 'stage' ? [`${message.stage}:${message.status}`] : [],
    );

async function startCoreChild(
  processes: ManagedProcessService,
  root: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
  cancellation?: ManagedProcessRequest['cancellation'],
) {
  const home = join(root, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  return processes.start({
    executable: process.execPath,
    args: [join(process.cwd(), 'dist/bin/revo-core-host.js')],
    cwd: process.cwd(),
    env: { ...childEnvironment(home), ...extraEnvironment },
    ...(cancellation === undefined ? {} : { cancellation }),
    ipc: true,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  });
}

async function waitFor(
  messages: unknown[],
  type: string,
  deadline = Date.now() + 30_000,
  completion: () =>
    | { readonly exitCode: number | null; readonly signal: string | null }
    | undefined = () => undefined,
  label = 'Core child',
) {
  const message = messages.map(parseCoreHostMessage).find((candidate) => candidate?.type === type);
  if (message) {
    return message;
  }
  const observedCompletion = completion();
  if (observedCompletion) {
    throw new Error(
      `${label} exited before ${type}: stages=${stageIds(messages).join(',')} exitCode=${String(observedCompletion.exitCode)} signal=${String(observedCompletion.signal)}`,
    );
  }
  if (Date.now() >= deadline) {
    throw new Error(`${label} did not send ${type}: stages=${stageIds(messages).join(',')}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  return waitFor(messages, type, deadline, completion, label);
}

const graphql = (url: string, deadline: number, label: string) =>
  boundedFetch(`${url}/graphql`, deadline, `${label} GraphQL`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ __typename }' }),
  }).then(({ body }) => JSON.parse(body));

async function boundedFetch(url: string, deadline: number, label: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const deadlineError = new Error(`${label} deadline expired`);
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw deadlineError;
  }
  const timer = setTimeout(() => controller.abort(deadlineError), remaining);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    if (controller.signal.reason === deadlineError) {
      throw deadlineError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const expire = () => reject(new Error(`${label} did not finish: ${state()}`));
      timer = setTimeout(expire, milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function withinDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  label = 'subprocess',
  state: () => string = () => 'state unavailable',
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(new Error(`${label} did not finish: ${state()}`));
  }
  return within(promise, remaining, label, state);
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
