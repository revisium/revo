import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { CoreHostProcessService } from '../../../src/core-host/core-host-process.service.js';
import { EmbeddedPostgresError, ExternalPostgresError } from '../../../src/postgres/index.js';
import { ControlClientService } from '../../../src/processes/control-client.service.js';
import {
  CONTROL_FILE,
  ControlDiscoveryService,
} from '../../../src/processes/control-discovery.service.js';
import { ManagedProcessService } from '../../../src/processes/managed-process.service.js';
import type {
  ManagedProcessRequest,
  OwnedProcess,
  ProcessCompletion,
  ProcessMessage,
  StopProcessRequest,
} from '../../../src/processes/managed-process.types.js';
import {
  PublishedControlError,
  PublishedControlService,
} from '../../../src/processes/published-control.service.js';
import { ServerOwnershipService } from '../../../src/processes/server-ownership.service.js';
import { parseLifecycleDocument } from '../../../src/server-logs/document.js';
import type { ServerLifecycleSink } from '../../../src/server-logs/server-lifecycle.types.js';
import { serverLifecyclePath } from '../../../src/server-logs/store.service.js';
import {
  ServerOwnerResource,
  ServerOwnerService,
} from '../../../src/server/server-owner.service.js';
import { ServerStatusService } from '../../../src/server/server-status.service.js';
import { ServerStopService } from '../../../src/server/server-stop.service.js';
import { ServerModule } from '../../../src/server/server.module.js';
import {
  StartupProgressDiscoveryService,
  StartupProgressJournalWriter,
} from '../../../src/startup-progress/startup-progress-journal.service.js';
import { ServerLifecycleProbe } from './server-lifecycle-probe.js';

const STARTUP_MILLISECONDS = 120_000;

export class ServerOwnerScenario {
  private root = '';
  private dataDir = '';
  private runtimeDir = '';
  private separateRuntimeRoot: string | undefined;
  private readonly owners: ServerOwnerResource[] = [];
  private readonly servers: Server[] = [];
  private readonly journals: OwnerJournal[] = [];
  private operation = 0;

  async setup() {
    this.root = await mkdtemp(join(await realpath(tmpdir()), 'revo-server-owner-'));
    this.dataDir = join(this.root, 'data');
    if (process.platform === 'darwin') {
      this.separateRuntimeRoot = await mkdtemp('/tmp/so-');
    }
    this.runtimeDir = this.separateRuntimeRoot ?? join(this.root, 'run');
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
      return (
        application.get(ServerOwnerService) instanceof ServerOwnerService &&
        application.get(ServerStatusService) instanceof ServerStatusService &&
        application.get(ServerStopService) instanceof ServerStopService
      );
    } finally {
      await application.close();
    }
  }

  async recordsLifecycle() {
    const controlled = await this.controlledOwner(new OwnerJournal(), false);
    await controlled.owner.start(new AbortController().signal);
    await controlled.owner.close();
    await controlled.owner.close();
    const serialized = await readFile(this.lifecyclePath(), 'utf8');
    if (serialized.includes('postgresql:') || serialized.includes('fixture')) {
      throw new Error('Lifecycle document exposed a connection detail');
    }
    const document = parseLifecycleDocument(serialized);
    if (!document) {
      throw new Error('Lifecycle document was not readable');
    }
    return document.events.map((event) => `${event.phase}:${event.state}:${event.code}`);
  }

  async cancellationDoesNotWaitForLifecycleEmit() {
    const lifecycle = new ServerLifecycleProbe();
    const controlled = await this.controlledOwner(
      new OwnerJournal(),
      false,
      false,
      false,
      false,
      lifecycle,
    );
    const controller = new AbortController();
    lifecycle.block('SERVER_READY', () => controller.abort());
    const starting = controlled.owner.start(controller.signal).then(
      () => 'ready' as const,
      () => 'failed' as const,
    );
    await waitBounded(lifecycle.entered);
    const contender = await new ServerOwnershipService().acquire(this.dataDir);
    lifecycle.release();
    const startResult = await starting;
    if (contender.kind === 'held') {
      await contender.release();
    }
    return { startResult, contender: contender.kind, codes: lifecycle.codes };
  }

  async ignoresLifecycleWriteRejections() {
    const lifecycle = new ServerLifecycleProbe(true);
    const controlled = await this.controlledOwner(
      new OwnerJournal(),
      false,
      false,
      false,
      false,
      lifecycle,
    );
    await controlled.owner.start(new AbortController().signal);
    await controlled.owner.close();
    return { rejections: lifecycle.rejections, ready: controlled.owner.status().phase };
  }

  async recordsFailureLifecycle(failure: 'database' | 'readiness' | 'core' | 'stop') {
    const lifecycle = new ServerLifecycleProbe();
    const controlled = await this.controlledOwner(
      new OwnerJournal(),
      failure === 'stop',
      false,
      false,
      failure === 'database' ? 'embedded' : false,
      lifecycle,
      failure === 'readiness',
    );
    if (failure === 'core') {
      await controlled.owner.start(new AbortController().signal);
      controlled.processes.child.completeNaturally();
      await controlled.owner.outcome();
    } else if (failure === 'stop') {
      await controlled.owner.start(new AbortController().signal);
      await Promise.allSettled([controlled.owner.close()]);
    } else {
      await controlled.owner.start(new AbortController().signal).catch(() => undefined);
    }
    return lifecycle.codes;
  }

  async recordsRejectedCoreLifecycle() {
    const lifecycle = new ServerLifecycleProbe();
    const controlled = await this.controlledOwner(
      new OwnerJournal(),
      false,
      false,
      false,
      false,
      lifecycle,
      false,
      'stable',
      true,
    );
    await controlled.owner.start(new AbortController().signal);
    controlled.processes.failCoreCompletion();
    await controlled.owner.outcome();
    return lifecycle.codes;
  }

  async recordsAlphaLifecycle() {
    const controlled = await this.controlledOwner(
      new OwnerJournal(),
      false,
      false,
      false,
      false,
      undefined,
      false,
      'alpha',
    );
    await controlled.owner.start(new AbortController().signal);
    await controlled.owner.close();
    const alpha = parseLifecycleDocument(await readFile(this.lifecyclePath('alpha'), 'utf8'));
    const stable = await readFile(this.lifecyclePath('stable'), 'utf8').catch(() => undefined);
    return { alpha: alpha?.events.length ?? 0, stable: stable !== undefined };
  }

  async recordsStartupFailureLifecycle() {
    await mkdir(join(this.dataDir, CONTROL_FILE));
    await new ServerOwnerService()
      .open({
        configuration: {
          channel: 'stable',
          dataDir: this.dataDir,
          logDir: join(this.root, 'logs'),
          host: '127.0.0.1',
          port: 0,
          publicUrl: 'http://127.0.0.1:3210',
          runtimeDir: this.runtimeDir,
          startupTimeout: 5_000,
          version: '0.0.0',
        },
        environment: this.environment(),
        operationId: this.nextOperation(),
      })
      .catch(() => undefined);
    const document = parseLifecycleDocument(await readFile(this.lifecyclePath(), 'utf8'));
    return document?.events.map((event) => event.code) ?? [];
  }

  async restartsExistingData() {
    const first = await this.open(this.nextOperation());
    await first.start(new AbortController().signal);
    await first.close();
    const stopped = first.status();
    const second = await this.open(this.nextOperation());
    const ready = await second.start(new AbortController().signal);
    return { ready, owners: this.owners.length, stopped };
  }

  async stopsThroughPublishedControl() {
    const owner = await this.open(this.nextOperation());
    await owner.start(new AbortController().signal);
    const discovered = await new ControlDiscoveryService().read(this.dataDir);
    if (discovered.kind !== 'found') {
      throw new Error('Published owner control was not found');
    }
    const completion = await new ControlClientService().requestStopAndWait(
      discovered.record,
      140_000,
    );
    if (completion.kind !== 'completed') {
      throw new Error('Published owner control reported failed cleanup');
    }
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
      const statusWhileClosing = controlled.owner.status();
      await waitBounded(controlled.processes.completed);
      const contender = await new ServerOwnershipService().acquire(this.dataDir);
      const contenderKind = contender.kind;
      if (contender.kind === 'held') {
        await contender.release();
      }
      return {
        contender: contenderKind,
        coreCompleted: controlled.processes.completionObserved,
        statusWhileClosing,
      };
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
    const failedStatus = controlled.owner.status();
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
      failedStatus,
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
    let ownershipReleased = false;
    void controlled.owner.ownershipReleased().then(() => (ownershipReleased = true));
    await controlled.owner.start(new AbortController().signal);
    const first = await controlled.owner.close().then(
      () => 'closed' as const,
      () => 'retained' as const,
    );
    const outcome = await controlled.owner.outcome();
    const contender = await new ServerOwnershipService().acquire(this.dataDir);
    const releasedBeforeRetry = ownershipReleased;
    await controlled.owner.close();
    await controlled.owner.ownershipReleased();
    const replacement = await new ServerOwnershipService().acquire(this.dataDir);
    if (replacement.kind === 'held') {
      await replacement.release();
    }
    return {
      first,
      outcome,
      contender: contender.kind,
      releasedBeforeRetry,
      releasedAfterRetry: ownershipReleased,
      replacement: replacement.kind,
    };
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

  async settlesEarlyStopWhenPublicationFails() {
    const controls = new EarlyStopFailControlService();
    const service = new ServerOwnerService(controls, new CoreHostProcessService());
    const opened = await service
      .open({
        configuration: {
          channel: 'stable',
          dataDir: this.dataDir,
          logDir: join(this.root, 'logs'),
          host: '127.0.0.1',
          port: 0,
          publicUrl: 'http://127.0.0.1:3210',
          runtimeDir: this.runtimeDir,
          startupTimeout: 100,
          version: '0.0.0',
        },
        environment: this.environment(),
        operationId: this.nextOperation(),
      })
      .then(
        () => 'opened' as const,
        () => 'publication-failed' as const,
      );
    const completion = await waitBounded(controls.completion, 500).then(
      () => 'resolved' as const,
      (error: unknown) =>
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              code: String('code' in error && error.code),
            }
          : { name: 'unknown', message: 'unknown', code: 'false' },
    );
    return { opened, completion };
  }

  async cleansLeaseWhenDatabaseStartFails(failCleanup = false) {
    const controlled = await this.controlledOwner(
      new OwnerJournal(),
      false,
      failCleanup,
      false,
      'embedded',
    );
    const startResult = await controlled.owner.start(new AbortController().signal).then(
      () => undefined,
      (error: unknown) =>
        error instanceof Error && 'code' in error
          ? {
              code: String(error.code),
              cleanupCode:
                'cleanupCode' in error && typeof error.cleanupCode === 'string'
                  ? error.cleanupCode
                  : undefined,
              databaseFailure: 'databaseFailure' in error ? error.databaseFailure : undefined,
              message: error.message,
              hasCause: 'cause' in error,
              safe: !JSON.stringify(error).includes('secret-database-detail'),
            }
          : 'unexpected',
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

  async projectsOnlyKnownDatabaseFailure(kind: 'external' | 'unknown') {
    const controlled = await this.controlledOwner(new OwnerJournal(), false, false, false, kind);
    return controlled.owner.start(new AbortController().signal).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) =>
        error instanceof Error && 'databaseFailure' in error
          ? {
              databaseFailure: error.databaseFailure,
              message: error.message,
              hasCause: 'cause' in error,
              safe: !String(error).includes('secret-database-detail'),
            }
          : { kind: 'unexpected' as const },
    );
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
      await Promise.all([
        rm(this.root, { recursive: true, force: true }),
        ...(this.separateRuntimeRoot
          ? [rm(this.separateRuntimeRoot, { recursive: true, force: true })]
          : []),
      ]);
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
        logDir: join(this.root, 'logs'),
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

  private lifecyclePath(channel: 'stable' | 'alpha' = 'stable') {
    return serverLifecyclePath({
      logDir: join(this.root, 'logs'),
      canonicalDataDir: this.dataDir,
      channel,
    });
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
    databaseFailure: false | 'embedded' | 'external' | 'unknown' = false,
    lifecycle?: ServerLifecycleSink,
    readinessFailure = false,
    channel: 'stable' | 'alpha' = 'stable',
    rejectCoreCompletion = false,
  ) {
    this.journals.push(journal);
    const processes = new OwnerControlledProcesses(failFirstStop);
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(readinessFailure ? '{}' : '{"data":{"__typename":"Query"}}');
    });
    this.servers.push(server);
    const port = await listen(server);
    processes.port = port;
    const controls = new RealLeaseControlService(
      journal,
      failFirstHeldClose,
      stopBeforeOwnerAssignment,
      databaseFailure,
      lifecycle,
    );
    const coreHosts = new CoreHostProcessService(processes);
    if (rejectCoreCompletion) {
      const openCore = coreHosts.open.bind(coreHosts);
      coreHosts.open = (binding) => {
        const resource = openCore(binding);
        resource.settled = () => processes.coreCompletion;
        return resource;
      };
    }
    const service = new ServerOwnerService(controls, coreHosts);
    const operationId = this.nextOperation();
    const result = await service.open({
      configuration: {
        channel,
        dataDir: this.dataDir,
        logDir: join(this.root, 'logs'),
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
    private readonly databaseFailure: false | 'embedded' | 'external' | 'unknown' = false,
    private readonly lifecycle: ServerLifecycleSink | undefined,
  ) {
    super(undefined, undefined, undefined, undefined, journal);
  }

  override async open(
    ...parameters: Parameters<PublishedControlService['open']>
  ): Promise<Awaited<ReturnType<PublishedControlService['open']>>> {
    if (this.stopBeforeOwnerAssignment) {
      void parameters[0].onStop();
    }
    const held = await super.open(...parameters);
    if (held.kind === 'busy') {
      return held;
    }
    return {
      ...held,
      startDatabase: () =>
        this.databaseFailure
          ? Promise.reject(
              this.databaseFailure === 'embedded'
                ? Object.assign(
                    new EmbeddedPostgresError('process', true, {
                      exitCode: 7,
                      signal: 'SIGABRT',
                    }),
                    { privateDetail: 'secret-database-detail' },
                  )
                : this.databaseFailure === 'external'
                  ? new ExternalPostgresError('connection')
                  : new Error('secret-database-detail'),
            )
          : Promise.resolve({ kind: 'external' as const }),
      close: async () => {
        this.closeAttempts += 1;
        if (this.failFirstClose && this.closeAttempts === 1) {
          throw new PublishedControlError('close', [], 'retained');
        }
        await held.close();
      },
      ...(this.lifecycle ? { lifecycle: this.lifecycle } : {}),
    };
  }
}

class EarlyStopFailControlService extends PublishedControlService {
  completion: Promise<unknown> = Promise.resolve(undefined);

  override async open(
    ...parameters: Parameters<PublishedControlService['open']>
  ): Promise<Awaited<ReturnType<PublishedControlService['open']>>> {
    this.completion = Promise.resolve(parameters[0].onStop());
    throw new PublishedControlError('startup');
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
  readonly coreCompletion: Promise<never>;
  private rejectCoreCompletion!: (error: Error) => void;
  private finishCompleted: (() => void) | undefined;
  readonly completed = new Promise<void>((resolve) => (this.finishCompleted = resolve));
  completionObserved = false;
  port = 0;
  startCalls = 0;
  private stopCalls = 0;

  constructor(private readonly failFirstStop: boolean) {
    super();
    this.coreCompletion = new Promise((_, reject) => (this.rejectCoreCompletion = reject));
  }

  failCoreCompletion() {
    this.rejectCoreCompletion(new Error('Controlled Core completion failed'));
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
