import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import { Client } from 'pg';

import { EmbeddedPostgresPreparationService } from '../../../src/postgres/embedded-postgres-preparation.service.js';
import { EmbeddedPostgresResourceService } from '../../../src/postgres/embedded-postgres-resource.service.js';
import {
  LoopbackPortAllocator,
  type ReservedLoopbackPort,
} from '../../../src/postgres/loopback-port-allocator.js';
import type { PublishedControl } from '../../../src/processes/control-discovery.types.js';
import { ManagedProcessService } from '../../../src/processes/managed-process.service.js';
import type { ManagedProcessRequest } from '../../../src/processes/managed-process.types.js';
import { PublishedControlService } from '../../../src/processes/published-control.service.js';
import { StartupProgressJournalWriter } from '../../../src/startup-progress/startup-progress-journal.service.js';
import { BlockingJournal } from '../startup-progress/blocking-journal.js';
import { ClusterFixture } from './postgres-readiness-scenario.js';
import { TrackedPostgresProcesses } from './tracked-postgres-processes.js';

const FIRST_OPERATION = 'abcdefabcdefabcdefabcdefabcdefab';
const SECOND_OPERATION = '12341234123412341234123412341234';

export class PostgresLifecycleScenario {
  private readonly owners: PublishedControl[] = [];
  private readonly roots: string[] = [];
  private readonly allocators: { close(): Promise<void> }[] = [];

  async persistsAcrossOwnedRestart() {
    const fixture = await this.fixture();
    const firstOwner = await this.open(fixture, FIRST_OPERATION);
    const first = await this.start(firstOwner);
    await this.query(fixture.dataDir, first.port, [
      'CREATE TABLE durable_value (value text NOT NULL)',
      "INSERT INTO durable_value (value) VALUES ('survives restart')",
    ]);
    const coalesced = await this.start(firstOwner);
    await firstOwner.close();

    const secondOwner = await this.open(fixture, SECOND_OPERATION);
    const second = await this.start(secondOwner);
    const rows = await this.query(fixture.dataDir, second.port, [
      'SELECT value FROM durable_value',
    ]);
    await secondOwner.close();
    return {
      first,
      coalesced,
      second,
      rows,
      passwordLength: (await readFile(join(fixture.dataDir, 'postgres-password'), 'utf8')).length,
    };
  }

  async rejectsAnAlreadyCancelledStart() {
    const fixture = await this.fixture();
    const owner = await this.open(fixture, FIRST_OPERATION);
    const controller = new AbortController();
    controller.abort();
    const outcome = await owner
      .startDatabase?.({ signal: controller.signal, timeoutMs: 5000 })
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    await owner.close();
    return outcome;
  }

  async retriesOnlyThreeConfirmedBindConflicts(conflicts: number) {
    const fixture = await this.fixture();
    const processes = new TrackedPostgresProcesses();
    const allocator = new ContendedPortAllocator(processes, conflicts);
    this.allocators.push(allocator);
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
      allocator,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, allocator, resource);
    const outcome = await this.start(owner).then(
      (started) => ({ kind: 'ready' as const, port: started.port }),
      () => ({ kind: 'rejected' as const }),
    );
    await owner.close();
    return {
      outcome,
      ports: allocator.ports.length,
      distinct: new Set(allocator.ports).size === allocator.ports.length,
      previousExited: allocator.previousExited,
      listeners: await allocator.inspectListeners(),
    };
  }

  async doesNotRespawnAfterAuthenticationFailure() {
    const fixture = await this.fixture();
    const processes = new TrackedPostgresProcesses();
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource);
    await owner.prepareEmbeddedPostgres?.({
      signal: new AbortController().signal,
      timeoutMs: 30_000,
    });
    await writeFile(
      join(fixture.dataDir, 'postgres-password'),
      'ffffffffffffffffffffffffffffffff',
      {
        mode: 0o600,
      },
    );
    const outcome = await this.start(owner).then(
      () => 'resolved',
      () => 'rejected',
    );
    await owner.close();
    return { outcome, postgresStarts: processes.postgresStarts };
  }

  async rejectsARealTrustServerWithTheWrongNonce() {
    const fixture = await this.fixture();
    const allocator = new ForeignPostgresAllocator();
    this.allocators.push(allocator);
    const owner = await this.open(fixture, FIRST_OPERATION, allocator);
    const outcome = await this.start(owner).then(
      (started) => ({ kind: 'ready' as const, port: started.port }),
      () => ({ kind: 'rejected' as const }),
    );
    await owner.close();
    return {
      outcome,
      postgresStarts: allocator.ownedAttempts,
      ownedPortDiffers: outcome.kind === 'ready' && outcome.port !== allocator.foreignPort,
      ...(await allocator.inspect()),
    };
  }

  async retainsOwnershipAfterStopFailureUntilTheOwnedServerActuallyExits() {
    const fixture = await this.fixture();
    const processes = new TrackedPostgresProcesses({ failFirstPostgresStop: true });
    const journal = new BlockingJournal();
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource, journal);
    try {
      await this.start(owner);
      if (!owner.progress) {
        throw new Error('startup progress missing');
      }
      journal.blockNext();
      const pendingProgress = owner.progress.progress('api-readiness');
      const progressOutcome = pendingProgress.then(
        () => 'fulfilled' as const,
        () => 'rejected' as const,
      );
      await waitForGate(journal.entered, progressOutcome);
      const firstClose = owner.close().then(
        () => 'resolved',
        () => 'rejected',
      );
      const repeatedClose = owner.close().then(
        () => 'resolved',
        () => 'rejected',
      );
      const closeOutcome = await firstClose;
      const sameOutcome = await repeatedClose;
      const busy = await this.openResult(fixture, SECOND_OPERATION);
      await processes.release();
      const beforeJournalDrain = await this.openResult(fixture, SECOND_OPERATION);
      journal.release();
      await pendingProgress;
      const reopened = await this.acquireEventually(fixture, SECOND_OPERATION, Date.now() + 2000);
      if (reopened?.kind === 'held') {
        this.owners.push(reopened);
        await reopened.close();
      }
      return {
        closeOutcome,
        sameOutcome,
        busy: busy.kind,
        beforeJournalDrain: beforeJournalDrain.kind,
        reopened: reopened?.kind,
        completion: await processes.completion,
      };
    } finally {
      journal.release();
      await processes.release().catch(() => undefined);
      await owner.close().catch(() => undefined);
    }
  }

  async cancelsAnActuallySpawnedServerBeforeReadinessCompletes() {
    const fixture = await this.fixture();
    const processes = new PausedSpawnProcesses();
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource);
    try {
      const controller = new AbortController();
      const starting = owner
        .startDatabase?.({ signal: controller.signal, timeoutMs: 30_000 })
        .then(toOutcome, toRejectedOutcome);
      if (!starting) {
        throw new Error('database owner missing');
      }
      await waitForGate(processes.spawned, starting);
      controller.abort();
      processes.continue();
      const outcome = await starting;
      return { outcome, completion: await processes.completion };
    } finally {
      processes.continue();
      await owner.close().catch(() => undefined);
    }
  }

  async abortsAfterReservationReleaseWithoutSpawningPostgres() {
    const fixture = await this.fixture();
    const ports = new GatedReleaseAllocator();
    const processes = new TrackedPostgresProcesses();
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
      ports,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, ports, resource);
    try {
      const controller = new AbortController();
      const starting = owner
        .startDatabase?.({ signal: controller.signal, timeoutMs: 30_000 })
        .then(toOutcome, toRejectedOutcome);
      if (!starting) {
        throw new Error('database owner missing');
      }
      await waitForGate(ports.releasing, starting);
      controller.abort();
      ports.continue();
      const outcome = await starting;
      return { outcome, postgresStarts: processes.postgresStarts };
    } finally {
      ports.continue();
      await owner.close().catch(() => undefined);
    }
  }

  async rejectsWhenTheReadyChildExitsDuringAcceptedCompletion(closeWhileBlocked = true) {
    const fixture = await this.fixture();
    const processes = new TrackedPostgresProcesses();
    const journal = new BlockingJournal();
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource, journal);
    journal.blockPostgresCompletion();
    try {
      const starting = this.start(owner).then(toOutcome, toRejectedOutcome);
      await waitForGate(journal.entered, starting);
      const closing = closeWhileBlocked
        ? owner.close().then(toOutcome, toRejectedOutcome)
        : Promise.resolve('not-requested');
      if (!closeWhileBlocked) {
        await processes.release();
      }
      const completion = await processes.completion;
      journal.release();
      const outcome = await starting;
      return { outcome, closeOutcome: await closing, completion };
    } finally {
      journal.release();
      await owner.close().catch(() => undefined);
    }
  }

  async rejectsRestartAfterFailedStartupStopUntilTheChildExits() {
    const fixture = await this.fixture();
    const processes = new TrackedPostgresProcesses({
      failFirstPostgresStop: true,
    });
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    );
    const owner = await this.open(fixture, FIRST_OPERATION, undefined, resource);
    try {
      await owner.prepareEmbeddedPostgres?.({
        signal: new AbortController().signal,
        timeoutMs: 30_000,
      });
      await writeFile(
        join(fixture.dataDir, 'postgres-password'),
        'ffffffffffffffffffffffffffffffff',
        { mode: 0o600 },
      );
      const first = await this.start(owner).then(
        () => 'resolved',
        () => 'rejected',
      );
      const repeated = await this.start(owner).then(
        () => 'resolved',
        () => 'rejected',
      );
      const startsBeforeExit = processes.postgresStarts;
      const closing = owner.close().catch(() => undefined);
      const busy = await this.openResult(fixture, SECOND_OPERATION);
      await processes.release();
      await closing;
      return { first, repeated, startsBeforeExit, busy: busy.kind };
    } finally {
      await processes.release().catch(() => undefined);
      await owner.close().catch(() => undefined);
    }
  }

  async cleanup() {
    await Promise.allSettled(
      this.owners.map((owner) => (owner.kind === 'held' ? owner.close() : Promise.resolve())),
    );
    await Promise.allSettled(this.allocators.map((allocator) => allocator.close()));
    await Promise.all(
      this.roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  }

  private async fixture() {
    const root = await mkdtemp('/tmp/pl-');
    this.roots.push(root);
    const dataDir = join(root, 'd');
    const runtimeDir = join(root, 'r');
    await Promise.all([mkdir(dataDir, { mode: 0o700 }), mkdir(runtimeDir, { mode: 0o700 })]);
    return { dataDir, runtimeDir };
  }

  private async open(
    fixture: { dataDir: string; runtimeDir: string },
    operationId: string,
    allocator?: LoopbackPortAllocator,
    suppliedResource?: EmbeddedPostgresResourceService,
    journal?: StartupProgressJournalWriter,
  ) {
    const resource =
      suppliedResource ??
      (allocator
        ? new EmbeddedPostgresResourceService(undefined, undefined, allocator)
        : undefined);
    const owner = await new PublishedControlService(
      undefined,
      undefined,
      undefined,
      undefined,
      journal,
      resource,
    ).open({
      ...fixture,
      version: '1.0.0',
      channel: 'stable',
      onStop: () => undefined,
      startupProgress: { operationId, now: () => performance.now() },
    });
    this.owners.push(owner);
    if (owner.kind !== 'held' || !owner.startDatabase) {
      throw new Error('database owner missing');
    }
    return owner;
  }

  private openResult(fixture: { dataDir: string; runtimeDir: string }, operationId: string) {
    return new PublishedControlService().open({
      ...fixture,
      version: '1.0.0',
      channel: 'stable',
      onStop: () => undefined,
      startupProgress: { operationId, now: () => performance.now() },
    });
  }

  private async acquireEventually(
    fixture: { dataDir: string; runtimeDir: string },
    operationId: string,
    deadline: number,
  ): Promise<PublishedControl> {
    const owner = await this.openResult(fixture, operationId);
    if (owner.kind === 'held' || Date.now() >= deadline) {
      return owner;
    }
    return new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() =>
      this.acquireEventually(fixture, operationId, deadline),
    );
  }

  private start(owner: Extract<PublishedControl, { kind: 'held' }>) {
    if (!owner.startDatabase) {
      throw new Error('database owner missing');
    }
    return owner.startDatabase({ signal: new AbortController().signal, timeoutMs: 30_000 });
  }

  private async query(dataDir: string, port: number, statements: readonly string[]) {
    const client = new Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password: await readFile(join(dataDir, 'postgres-password'), 'utf8'),
      database: 'revo',
      ssl: false,
    });
    await client.connect();
    try {
      const rows = await statements.reduce<Promise<unknown[]>>(async (previous, statement) => {
        await previous;
        return (await client.query(statement)).rows;
      }, Promise.resolve([]));
      return rows;
    } finally {
      await client.end();
    }
  }
}

class PausedSpawnProcesses extends ManagedProcessService {
  completion: Promise<unknown> | undefined;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private announce!: () => void;
  readonly spawned = new Promise<void>((resolve) => {
    this.announce = resolve;
  });

  override async start(request: ManagedProcessRequest) {
    const process = await super.start(request);
    if (request.args[0] === '-D') {
      this.completion = process.completion;
      this.announce();
      await this.gate;
    }
    return process;
  }

  continue() {
    this.release();
  }
}

class ContendedPortAllocator extends LoopbackPortAllocator {
  readonly ports: number[] = [];
  previousExited = true;
  private readonly listeners: Server[] = [];
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly processes: TrackedPostgresProcesses,
    private readonly conflicts: number,
  ) {
    super();
  }

  override async reserve(): Promise<ReservedLoopbackPort> {
    if (this.ports.length > 0) {
      this.previousExited &&= this.processes.completedPostgres >= this.ports.length;
    }
    const reservation = await super.reserve();
    const attempt = this.ports.push(reservation.port);
    return {
      port: reservation.port,
      release: async () => {
        await reservation.release();
        if (attempt <= this.conflicts) {
          const listener = createServer((socket) => {
            this.sockets.add(socket);
            socket.once('close', () => this.sockets.delete(socket));
            socket.once('data', () => socket.end('foreign-listener'));
          });
          await new Promise<void>((resolve, reject) => {
            listener.once('error', reject);
            listener.listen(
              { host: '127.0.0.1', port: reservation.port, exclusive: true },
              resolve,
            );
          });
          this.listeners.push(listener);
        }
      },
    };
  }

  inspectListeners() {
    return Promise.all(this.listeners.map((_listener, index) => readListener(this.ports[index])));
  }

  async close() {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await Promise.all(
      this.listeners.map(
        (listener) => new Promise<void>((resolve) => listener.close(() => resolve())),
      ),
    );
  }
}

class ForeignPostgresAllocator extends LoopbackPortAllocator {
  ownedAttempts = 0;
  foreignPort: number | undefined;
  private foreign: ClusterFixture | undefined;

  override async reserve() {
    const reservation = await super.reserve();
    this.ownedAttempts += 1;
    return {
      port: reservation.port,
      release: async () => {
        await reservation.release();
        if (!this.foreign) {
          this.foreignPort = reservation.port;
          this.foreign = await ClusterFixture.start('trust', reservation.port);
        }
      },
    };
  }

  async inspect() {
    if (!this.foreign) {
      throw new Error('foreign PostgreSQL missing');
    }
    return {
      reachable: await this.foreign.isAlive(),
      databaseCreated: await this.foreign.databaseExists(),
    };
  }

  async close() {
    if (this.foreign) {
      await this.foreign.close();
    }
  }
}

class GatedReleaseAllocator extends LoopbackPortAllocator {
  private releaseGate!: () => void;
  private notifyReleasing!: () => void;
  readonly releasing = new Promise<void>((resolve) => (this.notifyReleasing = resolve));
  private readonly gate = new Promise<void>((resolve) => (this.releaseGate = resolve));

  override async reserve() {
    const reservation = await super.reserve();
    return {
      port: reservation.port,
      release: async () => {
        await reservation.release();
        this.notifyReleasing();
        await this.gate;
      },
    };
  }

  continue() {
    this.releaseGate();
  }
}

const readListener = (port: number | undefined) =>
  new Promise<string>((resolve, reject) => {
    if (port === undefined) {
      reject(new Error('listener port missing'));
      return;
    }
    const socket = createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(1000, () => socket.destroy(new Error('listener timed out')));
    socket.once('connect', () => socket.write('probe'));
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.once('error', reject);
    socket.once('close', () => resolve(response));
  });

const toOutcome = () => 'resolved' as const;
const toRejectedOutcome = () => 'rejected' as const;
const waitForGate = async (gate: Promise<void>, outcome: Promise<unknown>): Promise<void> => {
  const reached = await Promise.race([
    gate.then(() => 'gate' as const),
    outcome?.then(() => 'outcome' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
  ]);
  if (reached !== 'gate') {
    throw new Error(`fixture gate was not reached: ${reached}`);
  }
};
