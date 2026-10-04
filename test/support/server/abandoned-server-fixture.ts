import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { CONTROL_FILE } from '../../../src/processes/control-discovery.service.js';
import type { HeldServerOwnership } from '../../../src/processes/ownership.types.js';
import { ServerOwnershipService } from '../../../src/processes/server-ownership.service.js';

const OWNER = new URL('../process/published-control-child.mjs', import.meta.url);

/** A data directory whose published server was killed and left its control record behind. */
export class AbandonedServerFixture {
  private readonly leases: HeldServerOwnership[] = [];

  private constructor(
    private readonly root: string,
    readonly dataDir: string,
  ) {}

  static async create(): Promise<AbandonedServerFixture> {
    const root = await realpath(await mkdtemp('/tmp/as-'));
    const fixture = new AbandonedServerFixture(root, join(root, 'd'));
    await mkdir(fixture.dataDir, { mode: 0o700 });
    await fixture.killPublishedServer();
    return fixture;
  }

  controlRecord(): Promise<string | undefined> {
    return readFile(join(this.dataDir, CONTROL_FILE), 'utf8').catch(() => undefined);
  }

  async holdOwnership(): Promise<void> {
    const lease = await new ServerOwnershipService().acquire(this.dataDir);
    if (lease.kind !== 'held') {
      throw new Error('abandoned data directory is unexpectedly owned');
    }
    this.leases.push(lease);
  }

  async dispose(): Promise<void> {
    await Promise.all(this.leases.splice(0).map((lease) => lease.release()));
    await rm(this.root, { recursive: true, force: true });
  }

  private async killPublishedServer(): Promise<void> {
    const owner = fork(OWNER, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        REVO_TEST_DATA: this.dataDir,
        REVO_TEST_LOG: join(this.root, 'l'),
        REVO_TEST_RUNTIME: join(this.root, 'r'),
      },
    });
    await new Promise<void>((resolve, reject) => {
      owner.once('message', () => resolve());
      owner.once('error', reject);
    });
    const exited = new Promise<void>((resolve) => owner.once('exit', () => resolve()));
    owner.kill('SIGKILL');
    await exited;
  }
}
