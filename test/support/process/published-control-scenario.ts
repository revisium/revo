import { execFile, fork, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ControlClientService } from '../../../src/processes/control-client.service.js';
import {
  CONTROL_FILE,
  ControlDiscoveryService,
} from '../../../src/processes/control-discovery.service.js';
import type { PublishedControl } from '../../../src/processes/control-discovery.types.js';
import { PublishedControlService } from '../../../src/processes/published-control.service.js';
import { ServerOwnershipService } from '../../../src/processes/server-ownership.service.js';

export class PublishedControlScenario {
  private readonly roots = new Set<string>();
  private readonly held: PublishedControl[] = [];
  private readonly children = new Set<ChildProcess>();

  async publishesFromDifferentProcess() {
    const fixture = await this.fixture();
    const child = await this.child(fixture);
    const discovery = await new ControlDiscoveryService().read(fixture.dataDir);
    const probe =
      discovery.kind === 'found'
        ? await new ControlClientService().probe(discovery.record)
        : undefined;
    const busy = await this.open(fixture);
    child.send('close');
    await onceExit(child);
    this.children.delete(child);
    return { discovery: discovery.kind, probe, busy: busy.kind };
  }

  async publishesAndPreventsSecondOwner() {
    const fixture = await this.fixture();
    const held = await this.open(fixture);
    const discovery = await new ControlDiscoveryService().read(fixture.dataDir);
    const probe =
      discovery.kind === 'found'
        ? await new ControlClientService().probe(discovery.record)
        : undefined;
    const busy = await this.open(fixture);
    return { held: held.kind, discovery: discovery.kind, probe, busy: busy.kind };
  }

  async publishesCanonicalAlias() {
    const fixture = await this.fixture();
    const alias = `${fixture.dataDir}-alias`;
    await symlink(fixture.dataDir, alias);
    this.roots.add(alias);
    const held = await this.open({ ...fixture, dataDir: alias });
    const discovery = await new ControlDiscoveryService().read(alias);
    return {
      canonical: discovery.kind === 'found' ? discovery.record.canonicalDataDir : undefined,
      dataDir: await realpath(fixture.dataDir),
      separateRuntime: held.kind === 'held' && !held.endpoint.startsWith(fixture.dataDir),
    };
  }

  async releasesAfterPublicationFailure() {
    const fixture = await this.fixture();
    await mkdir(join(fixture.dataDir, CONTROL_FILE));
    const failure = await Promise.allSettled([this.open(fixture)]);
    await rm(join(fixture.dataDir, CONTROL_FILE), { recursive: true });
    const retry = await this.open(fixture);
    return { failure: failure[0]?.status, retry: retry.kind };
  }

  async oldCloseCannotDeleteReplacement() {
    const fixture = await this.fixture();
    const old = await this.open(fixture);
    if (old.kind !== 'held') {
      return false;
    }
    await old.close();
    const replacement = await this.open(fixture);
    await old.close();
    return (
      replacement.kind === 'held' &&
      (await new ControlDiscoveryService().read(fixture.dataDir)).kind === 'found'
    );
  }

  async replacesCrashStaleRecord() {
    const fixture = await this.fixture();
    const child = await this.child(fixture);
    const stale = await new ControlDiscoveryService().read(fixture.dataDir);
    child.kill('SIGKILL');
    await onceExit(child);
    this.children.delete(child);
    const replacement = await this.open(fixture);
    const current = await new ControlDiscoveryService().read(fixture.dataDir);
    return {
      replacement: replacement.kind,
      changed:
        stale.kind === 'found' &&
        current.kind === 'found' &&
        stale.record.instanceId !== current.record.instanceId,
    };
  }

  async readsUnsafeMetadata() {
    const fixture = await this.fixture();
    const discovery = new ControlDiscoveryService();
    const path = join(fixture.dataDir, CONTROL_FILE);
    const results = [(await discovery.read(fixture.dataDir)).kind];
    await writeFile(path, '{bad', { mode: 0o600 });
    results.push((await discovery.read(fixture.dataDir)).kind);
    await writeFile(path, 'x'.repeat(16_385), { mode: 0o600 });
    results.push((await discovery.read(fixture.dataDir)).kind);
    await rm(path);
    await symlink('/dev/null', path);
    results.push((await discovery.read(fixture.dataDir)).kind);
    await rm(path);
    await mkdir(path);
    results.push((await discovery.read(fixture.dataDir)).kind);
    await rm(path, { recursive: true });
    await writeFile(path, '{}', { mode: 0o644 });
    results.push((await discovery.read(fixture.dataDir)).kind);
    await chmod(fixture.dataDir, 0o755);
    results.push((await discovery.read(fixture.dataDir)).kind);
    await chmod(fixture.dataDir, 0o700);
    return results;
  }

  async invalidFifoCloseStillReleasesOwnership() {
    const fixture = await this.fixture();
    const held = await this.open(fixture);
    if (held.kind !== 'held') {
      return undefined;
    }
    const locator = join(fixture.dataDir, CONTROL_FILE);
    await rm(locator);
    await new Promise<void>((resolve, reject) =>
      execFile('/usr/bin/mkfifo', [locator], (error) => (error ? reject(error) : resolve())),
    );
    const invalid = await new ControlDiscoveryService().read(fixture.dataDir);
    const closed = await Promise.allSettled([held.close()]);
    await held.ownershipReleased();
    const replacement = await this.open(fixture);
    return {
      invalid: invalid.kind,
      close: closed[0]?.status,
      ownershipReleased: true,
      replacement: replacement.kind,
    };
  }

  async rejectsOversizedPublicationAndReportsCleanupFailure() {
    const fixture = await this.fixture();
    const oversized = await Promise.allSettled([
      this.open({ ...fixture, version: 'v'.repeat(16_385) }),
    ]);
    const retry = await this.open(fixture);
    if (retry.kind === 'held') {
      await retry.close();
    }
    await mkdir(join(fixture.dataDir, CONTROL_FILE));
    const service = new PublishedControlService(new FailingReleaseOwnership(fixture.dataDir));
    const cleanup = await Promise.allSettled([service.open(fixture)]);
    return {
      oversized: oversized[0]?.status,
      retry: retry.kind,
      cleanup: cleanup[0]?.status === 'rejected' ? cleanup[0].reason : undefined,
    };
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
    const root = await mkdtemp(join(tmpdir(), 'pc-'));
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
  private async open(request: Awaited<ReturnType<PublishedControlScenario['fixture']>>) {
    const result = await new PublishedControlService().open(request);
    this.held.push(result);
    return result;
  }
  private async child(fixture: Awaited<ReturnType<PublishedControlScenario['fixture']>>) {
    const child = fork(new URL('./published-control-child.mjs', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { REVO_TEST_DATA: fixture.dataDir, REVO_TEST_RUNTIME: fixture.runtimeDir },
    });
    this.children.add(child);
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
    });
    return child;
  }
}

const onceExit = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once('exit', () => resolve()));

class FailingReleaseOwnership extends ServerOwnershipService {
  constructor(private readonly dataDir: string) {
    super();
  }
  override async acquire() {
    return {
      kind: 'held' as const,
      lockPath: join(this.dataDir, '.revo-server.lock'),
      release: async () => {
        throw new Error('secret release failure');
      },
    };
  }
}
