import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_HOST_PROTOCOL } from '../../../src/core-host/core-child-protocol.js';
import {
  CoreHostProcessResource,
  CoreHostProcessService,
} from '../../../src/core-host/core-host-process.service.js';
import { ManagedProcessService } from '../../../src/processes/managed-process.service.js';
import type {
  ManagedProcessRequest,
  OwnedProcess,
  ProcessCompletion,
  ProcessMessage,
  StopProcessRequest,
} from '../../../src/processes/managed-process.types.js';
import { ProcessExitWaiter } from '../../../src/processes/process-exit-waiter.js';

const CHILD = resolve(dirname(fileURLToPath(import.meta.url)), 'core-host-process-child.mjs');

class MissesFirstStopCompletion extends ProcessExitWaiter {
  private observations = 0;

  override async wait(): Promise<boolean> {
    this.observations += 1;
    return this.observations > 2;
  }
}

class ControlledProcess implements OwnedProcess {
  readonly completion: Promise<ProcessCompletion>;
  private resolveCompletion!: (completion: ProcessCompletion) => void;

  constructor(private readonly heldSend: boolean) {
    this.completion = new Promise(
      (resolveCompletion) => (this.resolveCompletion = resolveCompletion),
    );
  }

  send(message: ProcessMessage): Promise<void> {
    return this.heldSend &&
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'hello'
      ? new Promise(() => undefined)
      : Promise.resolve();
  }

  complete() {
    this.resolveCompletion({ exitCode: null, signal: 'SIGTERM' });
  }
}

class ControlledProcesses extends ManagedProcessService {
  readonly child: ControlledProcess;
  readonly started: Promise<OwnedProcess>;
  private releaseStart!: () => void;
  stopCalls = 0;
  startCalls = 0;

  constructor(
    pendingSpawn: boolean,
    heldSend = false,
    private readonly failFirstStop = false,
    rejectSpawn = false,
  ) {
    super();
    this.child = new ControlledProcess(heldSend);
    this.started = rejectSpawn
      ? Promise.reject(new Error('fixture spawn rejection'))
      : pendingSpawn
        ? new Promise((resolveStart) => (this.releaseStart = () => resolveStart(this.child)))
        : Promise.resolve(this.child);
    void this.started.catch(() => undefined);
  }

  override start(_request: ManagedProcessRequest) {
    this.startCalls += 1;
    return this.started;
  }

  override async stop(_handle: OwnedProcess, _request: StopProcessRequest) {
    this.stopCalls += 1;
    if (this.failFirstStop && this.stopCalls === 1) {
      throw new Error('fixture stop failure');
    }
    this.child.complete();
  }

  release() {
    this.releaseStart?.();
  }
}

export class CoreHostProcessScenario {
  private root = '';
  private readonly resources: CoreHostProcessResource[] = [];

  async setup() {
    this.root = await mkdtemp(join(tmpdir(), 'revo-core-host-process-'));
    return this;
  }

  resource(
    mode:
      | 'cooperative'
      | 'delayed-boot'
      | 'delayed-shutdown'
      | 'duplicate-listening'
      | 'early-listening'
      | 'exit-after-listening'
      | 'exit-before-boot'
      | 'exit-before-listening'
      | 'failed-then-listening'
      | 'late-stage-after-listening'
      | 'resistant',
    missedFirstStop = false,
  ) {
    const processes = missedFirstStop
      ? new ManagedProcessService(new MissesFirstStopCompletion())
      : new ManagedProcessService();
    const resource = new CoreHostProcessService(processes).open({
      executable: process.execPath,
      entry: CHILD,
      cwd: this.root,
      env: {
        REVO_CORE_HOST_FIXTURE_MODE: mode,
        REVO_CORE_HOST_FIXTURE_ROOT: this.root,
      },
    });
    this.resources.push(resource);
    return resource;
  }

  controlled(pendingSpawn: boolean, heldSend = false, failFirstStop = false, rejectSpawn = false) {
    const processes = new ControlledProcesses(pendingSpawn, heldSend, failFirstStop, rejectSpawn);
    const resource = new CoreHostProcessService(processes).open({
      executable: process.execPath,
      entry: CHILD,
      cwd: this.root,
      env: {},
    });
    this.resources.push(resource);
    return { processes, resource };
  }

  start(
    resource: CoreHostProcessResource,
    options: {
      readonly signal?: AbortSignal;
      readonly onStage?: Parameters<CoreHostProcessResource['start']>[1]['onStage'];
      readonly timeoutMs?: number;
    } = {},
  ) {
    return resource.start(
      {
        protocol: CORE_HOST_PROTOCOL,
        type: 'start',
        databaseUrl: 'postgresql://explicit.invalid/revo',
        temporaryWorkingDirectoryRoot: this.root,
        agentWorkspaceDirectory: this.root,
        host: '127.0.0.1',
        port: 0,
      },
      {
        signal: options.signal ?? new AbortController().signal,
        deadline: Date.now() + (options.timeoutMs ?? 2_000),
        onStage: options.onStage ?? (() => Promise.resolve()),
      },
    );
  }

  close(resource: CoreHostProcessResource, timeoutMs = 2_000) {
    return resource.close(Date.now() + timeoutMs);
  }

  async waitForBootBlock() {
    await waitUntil(async () => fileExists(join(this.root, 'boot-blocked')), Date.now() + 1_000);
  }

  termWasReceived() {
    return fileExists(join(this.root, 'term-received'));
  }

  async spawnCount() {
    try {
      return (await readFile(join(this.root, 'spawns'), 'utf8')).trim().split('\n').length;
    } catch {
      return 0;
    }
  }

  async cleanup() {
    const failures: unknown[] = [];
    const results = await Promise.allSettled(
      this.resources.map((resource) => this.close(resource, 1_000)),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        failures.push(result.reason);
      }
    }
    if (failures.length === 0) {
      await rm(this.root, { recursive: true, force: true });
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Core host process cleanup failed');
    }
  }
}

const fileExists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function waitUntil(predicate: () => Promise<boolean>, deadline: number): Promise<void> {
  if (await predicate()) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error('Core host fixture condition was not observed');
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  await waitUntil(predicate, deadline);
}
