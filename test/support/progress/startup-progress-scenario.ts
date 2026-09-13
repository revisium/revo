import { execFile, fork, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PublishedControlService } from '../../../src/processes/published-control.service.js';
import { ProgressOperation } from '../../../src/progress/index.js';
import {
  MAX_NONTERMINAL_TRANSITIONS,
  STARTUP_PROGRESS_FILE,
  STARTUP_PROGRESS_SCHEMA_VERSION,
  TERMINAL_PROGRESS_RESERVE_BYTES,
  StartupProgressDiscoveryService,
} from '../../../src/startup-progress/index.js';
import { StartupProgressJournalWriter } from '../../../src/startup-progress/startup-progress-journal.service.js';

const FIRST = '11111111111111111111111111111111';
const SECOND = '22222222222222222222222222222222';

export class StartupProgressScenario {
  private readonly roots = new Set<string>();
  private readonly held: Awaited<ReturnType<PublishedControlService['open']>>[] = [];
  private readonly children = new Set<ChildProcess>();

  async crossProcessReplay() {
    const fixture = await this.fixture();
    const child = fork(new URL('./startup-progress-child.mjs', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        REVO_TEST_DATA: fixture.dataDir,
        REVO_TEST_RUNTIME: fixture.runtimeDir,
        REVO_TEST_OPERATION: FIRST,
      },
    });
    this.children.add(child);
    await onceMessage(child);
    const reader = new StartupProgressDiscoveryService();
    const initial = await reader.read(fixture.dataDir, { operationId: FIRST, sequence: 0 });
    const cursor = initial.kind === 'events' ? (initial.events.at(-1)?.sequence ?? 0) : 0;
    const duplicate = await reader.read(fixture.dataDir, { operationId: FIRST, sequence: cursor });
    child.send('close');
    await onceExit(child);
    this.children.delete(child);
    return { initial, duplicate };
  }

  async operationChanges() {
    const fixture = await this.fixture();
    const first = await this.open(fixture, FIRST);
    if (first.kind === 'held') {
      await first.progress?.start('postgres-start');
      await first.close();
    }
    const second = await this.open(fixture, SECOND);
    const read = await new StartupProgressDiscoveryService().read(fixture.dataDir, {
      operationId: FIRST,
      sequence: 0,
    });
    return { second: second.kind, read };
  }

  async readyWriteFailure() {
    const fixture = await this.fixture();
    const journal = new FailAfterInitializationJournal();
    const held = await new PublishedControlService(
      undefined,
      undefined,
      undefined,
      undefined,
      journal,
    ).open({
      ...fixture,
      startupProgress: { operationId: FIRST, now: () => 0 },
    });
    this.held.push(held);
    if (held.kind !== 'held' || !held.progress) {
      return undefined;
    }
    const outcomes = await Promise.allSettled([
      held.progress.start('server-start'),
      held.progress.ready({ url: 'http://127.0.0.1:3210' }),
    ]);
    const read = await new StartupProgressDiscoveryService().read(fixture.dataDir, {
      operationId: FIRST,
      sequence: 0,
    });
    return { outcomes: outcomes.map(({ status }) => status), writes: journal.writes, read };
  }

  async transitionLimitReservesFailure() {
    const fixture = await this.fixture();
    const held = await this.open(fixture, FIRST);
    if (held.kind !== 'held' || !held.progress) {
      throw new Error('fixture did not acquire progress ownership');
    }
    const progress = held.progress;
    await Promise.all(
      Array.from({ length: MAX_NONTERMINAL_TRANSITIONS }, (_, index) =>
        progress.start(`phase-${index}`),
      ),
    );
    const overflow = await Promise.allSettled([progress.start('one-too-many')]);
    const read = await new StartupProgressDiscoveryService().read(fixture.dataDir, {
      operationId: FIRST,
      sequence: 0,
    });
    return {
      overflow: overflow[0]?.status,
      kind: read.kind,
      count: read.kind === 'events' ? read.events.length : 0,
      last: read.kind === 'events' ? read.events.at(-1) : undefined,
    };
  }

  async unsafeStates() {
    const fixture = await this.fixture();
    const path = join(fixture.dataDir, STARTUP_PROGRESS_FILE);
    const reader = new StartupProgressDiscoveryService();
    const kinds = [(await reader.read(fixture.dataDir, { operationId: FIRST, sequence: 0 })).kind];
    await writeFile(path, '{bad', { mode: 0o600 });
    kinds.push((await reader.read(fixture.dataDir, { operationId: FIRST, sequence: 0 })).kind);
    await writeFile(path, 'x'.repeat(256 * 1024 + 1), { mode: 0o600 });
    kinds.push((await reader.read(fixture.dataDir, { operationId: FIRST, sequence: 0 })).kind);
    await rm(path);
    await symlink('/dev/null', path);
    kinds.push((await reader.read(fixture.dataDir, { operationId: FIRST, sequence: 0 })).kind);
    await rm(path);
    await new Promise<void>((resolve, reject) =>
      execFile('/usr/bin/mkfifo', [path], (error) => (error ? reject(error) : resolve())),
    );
    kinds.push((await reader.read(fixture.dataDir, { operationId: FIRST, sequence: 0 })).kind);
    await rm(path);
    await writeFile(path, '{}', { mode: 0o644 });
    kinds.push((await reader.read(fixture.dataDir, { operationId: FIRST, sequence: 0 })).kind);
    await chmod(fixture.dataDir, 0o755);
    kinds.push((await reader.read(fixture.dataDir, { operationId: FIRST, sequence: 0 })).kind);
    await chmod(fixture.dataDir, 0o700);
    return kinds;
  }

  async invalidCursorAndElapsedOrder() {
    const fixture = await this.fixture();
    const reader = new StartupProgressDiscoveryService();
    const invalidCursors = await Promise.all([
      reader.read(fixture.dataDir, { operationId: 'bad', sequence: 0 }),
      reader.read(fixture.dataDir, { operationId: FIRST, sequence: Number.NaN }),
      reader.read(fixture.dataDir, { operationId: FIRST, sequence: Number.POSITIVE_INFINITY }),
    ]);
    let now = 0;
    const operation = new ProgressOperation({ operationId: FIRST, now: () => now });
    now = 10;
    const first = operation.start('runtime-download');
    now = 20;
    const second = operation.complete('runtime-download');
    if (!first || !second) {
      throw new Error('fixture did not emit');
    }
    await writeFile(
      join(fixture.dataDir, STARTUP_PROGRESS_FILE),
      `${JSON.stringify({
        schemaVersion: STARTUP_PROGRESS_SCHEMA_VERSION,
        operationId: FIRST,
        events: [first, { ...second, elapsedMs: 5 }],
      })}\n`,
      { mode: 0o600 },
    );
    const order = await reader.read(fixture.dataDir, { operationId: FIRST, sequence: 0 });
    return { cursors: invalidCursors.map(({ kind }) => kind), order: order.kind };
  }

  async initializationFailureReleasesOwnership() {
    const fixture = await this.fixture();
    const failed = await Promise.allSettled([
      new PublishedControlService(
        undefined,
        undefined,
        undefined,
        undefined,
        new AlwaysFailJournal(),
      ).open({ ...fixture, startupProgress: { operationId: FIRST, now: () => 0 } }),
    ]);
    const retry = await this.open(fixture, SECOND);
    return { failed: failed[0]?.status, retry: retry.kind };
  }

  async terminalByteBoundary() {
    const logPathAt = (extraBytes: number) => {
      const operation = new ProgressOperation({ operationId: FIRST, now: () => 0 });
      const base = operation.fail('server-start', { code: 'START_FAILED', logPath: 'x' });
      if (!base) {
        throw new Error('fixture did not emit');
      }
      const baseBytes = Buffer.byteLength(`${JSON.stringify(base)}\n`);
      return 'x'.repeat(TERMINAL_PROGRESS_RESERVE_BYTES - baseBytes + 1 + extraBytes);
    };
    const exactFixture = await this.fixture();
    const exactOwner = await this.open(exactFixture, FIRST);
    const oversizedFixture = await this.fixture();
    const oversizedOwner = await this.open(oversizedFixture, SECOND);
    if (
      exactOwner.kind !== 'held' ||
      !exactOwner.progress ||
      oversizedOwner.kind !== 'held' ||
      !oversizedOwner.progress
    ) {
      throw new Error('fixture did not acquire progress ownership');
    }
    const accepted = await Promise.allSettled([
      exactOwner.progress.fail('server-start', {
        code: 'START_FAILED',
        logPath: logPathAt(0),
      }),
    ]);
    const rejected = await Promise.allSettled([
      oversizedOwner.progress.fail('server-start', {
        code: 'START_FAILED',
        logPath: logPathAt(1),
      }),
    ]);
    const read = await new StartupProgressDiscoveryService().read(oversizedFixture.dataDir, {
      operationId: SECOND,
      sequence: 0,
    });
    return {
      accepted: accepted[0]?.status,
      rejected: rejected[0]?.status,
      last: read.kind === 'events' ? read.events.at(-1) : undefined,
    };
  }

  async closeDrainsAcceptedWriteBeforeRelease() {
    const fixture = await this.fixture();
    const journal = new GatedJournal();
    const held = await new PublishedControlService(
      undefined,
      undefined,
      undefined,
      undefined,
      journal,
    ).open({ ...fixture, startupProgress: { operationId: FIRST, now: () => 0 } });
    this.held.push(held);
    if (held.kind !== 'held' || !held.progress) {
      return undefined;
    }
    const accepted = held.progress.start('runtime-extract');
    await journal.entered;
    const closing = held.close();
    const late = await Promise.allSettled([held.progress.progress('runtime-extract')]);
    const busy = await new PublishedControlService().open(fixture);
    journal.release();
    await Promise.all([accepted, closing]);
    const replacement = await this.open(fixture, SECOND);
    return { late: late[0]?.status, busy: busy.kind, replacement: replacement.kind };
  }

  async cleanup() {
    for (const child of this.children) {
      child.kill('SIGKILL');
    }
    await Promise.allSettled([...this.children].map(onceExit));
    await Promise.allSettled(
      this.held.flatMap((held) => (held.kind === 'held' ? [held.close()] : [])),
    );
    await Promise.allSettled(
      [...this.roots].map((root) => rm(root, { recursive: true, force: true })),
    );
  }

  private async fixture() {
    const root = await mkdtemp(join(tmpdir(), 'sp-'));
    this.roots.add(root);
    const dataDir = join(root, 'd');
    await mkdir(dataDir, { mode: 0o700 });
    return {
      dataDir,
      runtimeDir: join(root, 'r'),
      version: '1.2.3',
      channel: 'stable',
      onStop: () => undefined,
    };
  }
  private async open(
    fixture: Awaited<ReturnType<StartupProgressScenario['fixture']>>,
    operationId: string,
  ) {
    const held = await new PublishedControlService().open({
      ...fixture,
      startupProgress: { operationId, now: () => 0 },
    });
    this.held.push(held);
    return held;
  }
}

class FailAfterInitializationJournal extends StartupProgressJournalWriter {
  writes = 0;
  override async write(...parameters: Parameters<StartupProgressJournalWriter['write']>) {
    this.writes += 1;
    if (this.writes === 2) {
      throw new Error('secret filesystem failure');
    }
    return super.write(...parameters);
  }
}

class AlwaysFailJournal extends StartupProgressJournalWriter {
  override async write() {
    throw new Error('secret initialization failure');
  }
}

class GatedJournal extends StartupProgressJournalWriter {
  private writes = 0;
  private unblock!: () => void;
  private notify!: () => void;
  readonly entered = new Promise<void>((resolve) => {
    this.notify = resolve;
  });
  private readonly blocked = new Promise<void>((resolve) => {
    this.unblock = resolve;
  });
  release() {
    this.unblock();
  }
  override async write(...parameters: Parameters<StartupProgressJournalWriter['write']>) {
    this.writes += 1;
    if (this.writes === 2) {
      this.notify();
      await this.blocked;
    }
    return super.write(...parameters);
  }
}

const onceMessage = (child: ChildProcess) =>
  new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('error', reject);
  });
const onceExit = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once('exit', () => resolve()));
