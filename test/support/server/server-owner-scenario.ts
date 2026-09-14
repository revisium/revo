import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { CoreHostProcessService } from '../../../src/core-host/core-host-process.service.js';
import { ControlClientService } from '../../../src/processes/control-client.service.js';
import { ControlDiscoveryService } from '../../../src/processes/control-discovery.service.js';
import { ManagedProcessService } from '../../../src/processes/managed-process.service.js';
import type {
  ManagedProcessRequest,
  OwnedProcess,
  ProcessCompletion,
  ProcessMessage,
  StopProcessRequest,
} from '../../../src/processes/managed-process.types.js';
import { PublishedControlService } from '../../../src/processes/published-control.service.js';
import { ServerOwnershipService } from '../../../src/processes/server-ownership.service.js';
import {
  ServerOwnerResource,
  ServerOwnerService,
} from '../../../src/server/server-owner.service.js';
import { ServerModule } from '../../../src/server/server.module.js';
import {
  StartupProgressDiscoveryService,
  StartupProgressJournalWriter,
} from '../../../src/startup-progress/startup-progress-journal.service.js';

const STARTUP_MILLISECONDS = 120_000;

export class ServerOwnerScenario {
  private root = '';
  private dataDir = '';
  private runtimeDir = '';
  private readonly owners: ServerOwnerResource[] = [];
  private readonly servers: Server[] = [];
  private readonly journals: OwnerJournal[] = [];
  private operation = 0;

  async setup() {
    this.root = await mkdtemp(join(tmpdir(), 'revo-server-owner-'));
    this.dataDir = join(this.root, 'data');
    this.runtimeDir = join(this.root, 'run');
    await Promise.all([
      mkdir(this.dataDir, { mode: 0o700 }),
      mkdir(join(this.root, 'home'), { mode: 0o700 }),
      mkdir(join(this.root, 'xdg'), { mode: 0o700 }),
    ]);
    return this;
  }

  async startsEmbedded() {
    const operationId = this.nextOperation();
    const owner = await this.open(operationId);
    const ready = await owner.start(new AbortController().signal);
    const progress = await new StartupProgressDiscoveryService().read(this.dataDir, {
      operationId,
      sequence: 0,
    });
    return {
      ready,
      events: progress.kind === 'events' ? progress.events : [],
    };
  }

  async resolvesServerOwnerThroughNest() {
    const application = await NestFactory.createApplicationContext(ServerModule, {
      logger: false,
    });
    try {
      return application.get(ServerOwnerService) instanceof ServerOwnerService;
    } finally {
      await application.close();
    }
  }

  async restartsExistingData() {
    const first = await this.open(this.nextOperation());
    await first.start(new AbortController().signal);
    await first.close();
    const second = await this.open(this.nextOperation());
    const ready = await second.start(new AbortController().signal);
    return { ready, owners: this.owners.length };
  }

  async stopsThroughPublishedControl() {
    const owner = await this.open(this.nextOperation());
    await owner.start(new AbortController().signal);
    const discovered = await new ControlDiscoveryService().read(this.dataDir);
    if (discovered.kind !== 'found') {
      throw new Error('Published owner control was not found');
    }
    await new ControlClientService().requestStop(discovered.record);
    const outcome = await waitBounded(owner.outcome(), 15_000);
    if (outcome.kind !== 'stopped') {
      throw new Error('Published control stop did not fully clean up the owner');
    }
    const replacement = await new ServerOwnershipService().acquire(this.dataDir);
    if (replacement.kind === 'held') {
      await replacement.release();
    }
    return { outcome, replacement: replacement.kind };
  }

  async holdsLeaseUntilBlockedJournalDrains() {
    const journal = new OwnerJournal();
    const controlled = await this.controlledOwner(journal, false);
    journal.blockNext();
    const starting = controlled.owner.start(new AbortController().signal).catch(() => undefined);
    let closing: Promise<void> | undefined;
    try {
      await waitBounded(journal.entered);
      closing = controlled.owner.close();
      await waitBounded(controlled.processes.completed);
      const contender = await new ServerOwnershipService().acquire(this.dataDir);
      const contenderKind = contender.kind;
      if (contender.kind === 'held') {
        await contender.release();
      }
      return { contender: contenderKind, coreCompleted: controlled.processes.completionObserved };
    } finally {
      journal.release();
      await closing;
      await starting;
    }
  }

  async retainsLeaseAfterFailedCoreStop() {
    const controlled = await this.controlledOwner(new OwnerJournal(), true);
    await controlled.owner.start(new AbortController().signal);
    const first = await Promise.allSettled([controlled.owner.close()]);
    const outcome = await controlled.owner.outcome();
    const contender = await new ServerOwnershipService().acquire(this.dataDir);
    await controlled.owner.close();
    const replacement = await new ServerOwnershipService().acquire(this.dataDir);
    if (replacement.kind === 'held') {
      await replacement.release();
    }
    return {
      first: first[0]?.status,
      contender: contender.kind,
      replacement: replacement.kind,
      starts: controlled.processes.startCalls,
      outcome,
    };
  }

  async cleansAfterNaturalCoreExit() {
    const controlled = await this.controlledOwner(new OwnerJournal(), false);
    await controlled.owner.start(new AbortController().signal);
    controlled.processes.child.completeNaturally();
    const outcome = await controlled.owner.outcome();
    const replacement = await new ServerOwnershipService().acquire(this.dataDir);
    if (replacement.kind === 'held') {
      await replacement.release();
    }
    return { outcome, replacement: replacement.kind };
  }

  async retriesFailedHeldCleanup() {
    const controlled = await this.controlledOwner(new OwnerJournal(), false, true);
    await controlled.owner.start(new AbortController().signal);
    const first = await controlled.owner.close().then(
      () => 'closed' as const,
      () => 'retained' as const,
    );
    const outcome = await controlled.owner.outcome();
    const contender = await new ServerOwnershipService().acquire(this.dataDir);
    await controlled.owner.close();
    const replacement = await new ServerOwnershipService().acquire(this.dataDir);
    if (replacement.kind === 'held') {
      await replacement.release();
    }
    return { first, outcome, contender: contender.kind, replacement: replacement.kind };
  }

  async latchesStopBeforeOwnerAssignment() {
    const controlled = await this.controlledOwner(new OwnerJournal(), false, false, true);
    const startResult = await controlled.owner.start(new AbortController().signal).then(
      () => 'started' as const,
      () => 'stopped' as const,
    );
    const replacement = await new ServerOwnershipService().acquire(this.dataDir);
    if (replacement.kind === 'held') {
      await replacement.release();
    }
    return { startResult, replacement: replacement.kind, starts: controlled.processes.startCalls };
  }

  async cleansLeaseWhenDatabaseStartFails() {
    const controlled = await this.controlledOwner(new OwnerJournal(), false, false, false, true);
    const startResult = await controlled.owner.start(new AbortController().signal).then(
      () => undefined,
      (error: unknown) =>
        error instanceof Error && 'code' in error ? String(error.code) : 'unexpected',
    );
    const outcome = await controlled.owner.outcome();
    const replacement = await new ServerOwnershipService().acquire(this.dataDir);
    if (replacement.kind === 'held') {
      await replacement.release();
    }
    return {
      startResult,
      outcome,
      replacement: replacement.kind,
      starts: controlled.processes.startCalls,
    };
  }

  async cancelsBeforeReadyCommit() {
    const journal = new OwnerJournal();
    const controlled = await this.controlledOwner(journal, false);
    const controller = new AbortController();
    journal.blockReady();
    const starting = controlled.owner.start(controller.signal).then(
      () => 'ready' as const,
      () => 'failed' as const,
    );
    let contender: Awaited<ReturnType<ServerOwnershipService['acquire']>>;
    try {
      await waitBounded(journal.entered);
      controller.abort();
      await waitBounded(controlled.processes.completed);
      contender = await new ServerOwnershipService().acquire(this.dataDir);
      if (contender.kind === 'held') {
        await contender.release();
      }
    } finally {
      journal.release();
    }
    const startResult = await starting;
    const progress = await new StartupProgressDiscoveryService().read(this.dataDir, {
      operationId: controlled.operationId,
      sequence: 0,
    });
    if (progress.kind !== 'events') {
      throw new Error('Startup progress journal was not readable');
    }
    return {
      startResult,
      contender: contender.kind,
      coreCompleted: controlled.processes.completionObserved,
      readyRecords: progress.events.filter((event) => event.status === 'ready').length,
    };
  }

  async cancelsAfterReadyCommitFence() {
    const journal = new OwnerJournal();
    const controlled = await this.controlledOwner(journal, false);
    const controller = new AbortController();
    journal.abortAfterReadyFence(controller);
    const startResult = await controlled.owner.start(controller.signal).then(
      () => 'ready' as const,
      () => 'failed' as const,
    );
    const progress = await new StartupProgressDiscoveryService().read(this.dataDir, {
      operationId: controlled.operationId,
      sequence: 0,
    });
    if (progress.kind !== 'events') {
      throw new Error('Startup progress journal was not readable');
    }
    return {
      startResult,
      readyRecords: progress.events.filter((event) => event.status === 'ready').length,
    };
  }

  async cleanup() {
    for (const journal of this.journals) {
      journal.release();
    }
    const ownerResults = await Promise.allSettled(this.owners.map((owner) => owner.close()));
    const serverResults = await Promise.allSettled(
      this.servers.map((server) => closeServer(server)),
    );
    const failures = [...ownerResults, ...serverResults].flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length === 0) {
      await rm(this.root, { recursive: true, force: true });
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Server owner cleanup failed');
    }
  }

  private async open(operationId: string) {
    const result = await new ServerOwnerService().open({
      configuration: {
        channel: 'stable',
        dataDir: this.dataDir,
        host: '127.0.0.1',
        port: 0,
        publicUrl: 'http://127.0.0.1:3210',
        runtimeDir: this.runtimeDir,
        startupTimeout: STARTUP_MILLISECONDS,
        version: '0.0.0',
      },
      environment: this.environment(),
      coreEntry: join(process.cwd(), 'dist/bin/revo-core-host.js'),
      operationId,
    });
    if (result.kind === 'busy') {
      throw new Error('Server owner lease is unexpectedly busy');
    }
    this.owners.push(result);
    return result;
  }

  private nextOperation() {
    this.operation += 1;
    return this.operation.toString(16).padStart(32, '0');
  }

  private environment(): NodeJS.ProcessEnv {
    return {
      HOME: join(this.root, 'home'),
      XDG_CONFIG_HOME: join(this.root, 'xdg'),
      USER: 'node',
      LOGNAME: 'node',
      LANG: 'C.UTF-8',
      PATH: '/opt/revo-prod-r7-tools/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      SHELL: '/bin/sh',
      TMPDIR: this.root,
    };
  }

  private async controlledOwner(
    journal: OwnerJournal,
    failFirstStop: boolean,
    failFirstHeldClose = false,
    stopBeforeOwnerAssignment = false,
    failDatabaseStart = false,
  ) {
    this.journals.push(journal);
    const processes = new OwnerControlledProcesses(failFirstStop);
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"data":{"__typename":"Query"}}');
    });
    this.servers.push(server);
    const port = await listen(server);
    processes.port = port;
    const controls = new RealLeaseControlService(
      journal,
      failFirstHeldClose,
      stopBeforeOwnerAssignment,
      failDatabaseStart,
    );
    const service = new ServerOwnerService(controls, new CoreHostProcessService(processes));
    const operationId = this.nextOperation();
    const result = await service.open({
      configuration: {
        channel: 'stable',
        dataDir: this.dataDir,
        databaseUrl: 'postgresql://postgres:fixture@127.0.0.1:5432/revo?sslmode=disable',
        host: '127.0.0.1',
        port: 0,
        publicUrl: 'http://127.0.0.1:3210',
        runtimeDir: this.runtimeDir,
        startupTimeout: 5_000,
        version: '0.0.0',
      },
      environment: this.environment(),
      operationId,
    });
    if (result.kind === 'busy') {
      throw new Error('Controlled owner lease is unexpectedly busy');
    }
    this.owners.push(result);
    return { owner: result, processes, operationId };
  }
}

class OwnerJournal extends StartupProgressJournalWriter {
  private notifyEntered: (() => void) | undefined;
  private releaseCompletion: (() => void) | undefined;
  entered: Promise<void> = Promise.resolve();
  private completion: Promise<void> = Promise.resolve();
  private blocked = false;
  private readyOnly = false;
  private readyAbort: AbortController | undefined;

  blockNext() {
    this.blocked = true;
    this.entered = new Promise((resolveEntered) => (this.notifyEntered = resolveEntered));
    this.completion = new Promise(
      (resolveCompletion) => (this.releaseCompletion = resolveCompletion),
    );
  }

  blockReady() {
    this.blockNext();
    this.readyOnly = true;
  }

  abortAfterReadyFence(controller: AbortController) {
    this.readyAbort = controller;
  }

  release() {
    this.releaseCompletion?.();
  }

  override async write(...parameters: Parameters<StartupProgressJournalWriter['write']>) {
    const ready = parameters[2].at(-1)?.status === 'ready';
    if (this.blocked && (!this.readyOnly || ready)) {
      this.blocked = false;
      this.notifyEntered?.();
      await this.completion;
    }
    if (ready && this.readyAbort && parameters[3]) {
      const context = parameters[3];
      const controller = this.readyAbort;
      parameters[3] = {
        ...context,
        assertRunning: () => {
          context.assertRunning();
          queueMicrotask(() => controller.abort());
        },
      };
    }
    return super.write(...parameters);
  }
}

class RealLeaseControlService extends PublishedControlService {
  private closeAttempts = 0;

  constructor(
    journal: StartupProgressJournalWriter,
    private readonly failFirstClose = false,
    private readonly stopBeforeOwnerAssignment = false,
    private readonly failDatabaseStart = false,
  ) {
    super(undefined, undefined, undefined, undefined, journal);
  }

  override async open(...parameters: Parameters<PublishedControlService['open']>) {
    if (this.stopBeforeOwnerAssignment) {
      await parameters[0].onStop();
    }
    const held = await super.open(...parameters);
    if (held.kind === 'busy') {
      return held;
    }
    return {
      ...held,
      startDatabase: () =>
        this.failDatabaseStart
          ? Promise.reject(new Error('Controlled database start failure'))
          : Promise.resolve({ kind: 'external' as const }),
      close: async () => {
        this.closeAttempts += 1;
        if (this.failFirstClose && this.closeAttempts === 1) {
          throw new Error('Controlled held close failure');
        }
        await held.close();
      },
    };
  }
}

class OwnerControlledChild implements OwnedProcess {
  readonly completion: Promise<ProcessCompletion>;
  private completeChild: ((completion: ProcessCompletion) => void) | undefined;
  private listener: ((message: unknown) => void) | undefined;

  constructor(private readonly processes: OwnerControlledProcesses) {
    this.completion = new Promise((resolveCompletion) => (this.completeChild = resolveCompletion));
  }

  subscribe(listener: (message: unknown) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async send(message: ProcessMessage) {
    if (!isMessage(message)) {
      return;
    }
    if (message.type === 'hello') {
      queueMicrotask(() => this.listener?.({ protocol: 'revo-core-host/v1', type: 'booted' }));
    }
    if (message.type === 'start') {
      queueMicrotask(() => {
        this.listener?.({
          protocol: 'revo-core-host/v1',
          type: 'stage',
          stage: 'application-database-migrations',
          status: 'started',
        });
        this.listener?.({
          protocol: 'revo-core-host/v1',
          type: 'stage',
          stage: 'application-database-migrations',
          status: 'completed',
        });
        this.listener?.({
          protocol: 'revo-core-host/v1',
          type: 'listening',
          host: '127.0.0.1',
          port: this.processes.port,
          url: `http://127.0.0.1:${String(this.processes.port)}`,
        });
      });
    }
  }

  complete() {
    this.completeChild?.({ exitCode: null, signal: 'SIGTERM' });
    this.processes.observeCompletion();
  }

  completeNaturally() {
    this.completeChild?.({ exitCode: 1, signal: null });
    this.processes.observeCompletion();
  }
}

class OwnerControlledProcesses extends ManagedProcessService {
  readonly child = new OwnerControlledChild(this);
  private finishCompleted: (() => void) | undefined;
  readonly completed = new Promise<void>((resolve) => (this.finishCompleted = resolve));
  completionObserved = false;
  port = 0;
  startCalls = 0;
  private stopCalls = 0;

  constructor(private readonly failFirstStop: boolean) {
    super();
  }

  override async start(_request: ManagedProcessRequest) {
    this.startCalls += 1;
    return this.child;
  }

  override async stop(_child: OwnedProcess, _request: StopProcessRequest) {
    this.stopCalls += 1;
    if (this.failFirstStop && this.stopCalls === 1) {
      throw new Error('Controlled Core stop failed');
    }
    this.child.complete();
  }

  observeCompletion() {
    this.completionObserved = true;
    this.finishCompleted?.();
  }
}

const isMessage = (value: ProcessMessage): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen);
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectListen(new Error('Controlled HTTP server did not bind'));
        return;
      }
      resolveListen(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
}

function waitBounded<T>(operation: Promise<T>, timeoutMs = 1_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Controlled completion was not observed')),
      timeoutMs,
    );
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
