// oxlint-disable-next-line import/no-unassigned-import -- Nest decorators need metadata first
import 'reflect-metadata';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NestFactory } from '@nestjs/core';

import {
  PosixFlockAdapter,
  type FlockBinding,
} from '../../../src/processes/adapters/posix-flock.adapter.js';
import type {
  HeldServerOwnership,
  ServerOwnership,
} from '../../../src/processes/ownership.types.js';
import { ProcessesModule } from '../../../src/processes/processes.module.js';
import { ServerOwnershipService } from '../../../src/processes/server-ownership.service.js';

const DRIVER = resolve(dirname(fileURLToPath(import.meta.url)), 'owner-process.mjs');

type Reply = Readonly<Record<string, boolean | number | string | undefined>>;

class FailingUnlockAdapter extends PosixFlockAdapter {
  protected override async loadBinding(): Promise<FlockBinding> {
    return bindingFor((_descriptor, operation) => (operation === 8 ? -1 : 0));
  }
}

class FailingAcquireAdapter extends PosixFlockAdapter {
  private descriptor: number | undefined;

  protected override async loadBinding(): Promise<FlockBinding> {
    return bindingFor((descriptor) => {
      this.descriptor = descriptor;
      return -1;
    });
  }

  descriptorIsClosed(): boolean {
    if (this.descriptor === undefined) {
      return false;
    }
    try {
      fstatSync(this.descriptor);
      return false;
    } catch (error) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EBADF') {
        return true;
      }
      throw error;
    }
  }
}

function bindingFor(call: (descriptor: number, operation: number) => number): FlockBinding {
  return {
    call,
    errno: () => 5,
    tryAgain: 11,
    wouldBlock: 11,
  };
}

export class OwnerProcess {
  private constructor(private readonly child: ChildProcess) {}

  static async start(): Promise<OwnerProcess> {
    const child = fork(DRIVER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const owner = new OwnerProcess(child);
    await owner.nextReply();
    return owner;
  }

  request(action: string, dataDir?: string): Promise<Reply> {
    const reply = this.nextReply();
    this.child.send({ action, dataDir });
    return reply;
  }

  async kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolveExit) => this.child.once('exit', () => resolveExit()));
    this.child.kill(signal);
    await exited;
  }

  private nextReply(): Promise<Reply> {
    return new Promise((resolveReply, reject) => {
      const timeout = setTimeout(() => reject(new Error('Ownership process timed out.')), 3_000);
      this.child.once('message', (message: Reply) => {
        clearTimeout(timeout);
        if (message.error !== undefined) {
          reject(new Error(String(message.error)));
          return;
        }
        resolveReply(message);
      });
    });
  }
}

export class OwnershipScenario {
  private readonly children: OwnerProcess[] = [];
  private readonly leases: HeldServerOwnership[] = [];
  private readonly unrelatedChildren: number[] = [];
  private readonly ownership = new ServerOwnershipService();
  private readonly failingAcquire = new FailingAcquireAdapter();
  private root = '';

  async setup(): Promise<this> {
    this.root = await mkdtemp(path.join(tmpdir(), 'revo-ownership-'));
    await chmod(this.root, 0o700);
    return this;
  }

  dataDir(name = 'data'): string {
    return path.join(this.root, name);
  }

  async aliasFor(dataDir: string): Promise<string> {
    const alias = this.dataDir('alias');
    await symlink(dataDir, alias);
    return alias;
  }

  async owner(): Promise<OwnerProcess> {
    const owner = await OwnerProcess.start();
    this.children.push(owner);
    return owner;
  }

  async acquire(dataDir: string): Promise<ServerOwnership> {
    const ownership = await this.ownership.acquire(dataDir);
    if (ownership.kind === 'held') {
      this.leases.push(ownership);
    }
    return ownership;
  }

  async leaseWithFailingRelease(): Promise<HeldServerOwnership> {
    const ownership = await new ServerOwnershipService(new FailingUnlockAdapter()).acquire(
      this.dataDir(),
    );
    if (ownership.kind !== 'held') {
      throw new Error('Expected the fixture ownership lease to be held.');
    }
    this.leases.push(ownership);
    return ownership;
  }

  async failNativeAcquire(): Promise<void> {
    await new ServerOwnershipService(this.failingAcquire).acquire(this.dataDir());
  }

  failedNativeDescriptorIsClosed(): boolean {
    return this.failingAcquire.descriptorIsClosed();
  }

  async acquireThroughNest(dataDir: string): Promise<ServerOwnership> {
    const application = await NestFactory.createApplicationContext(ProcessesModule, {
      logger: false,
    });
    try {
      const ownership = await application.get(ServerOwnershipService).acquire(dataDir);
      if (ownership.kind === 'held') {
        this.leases.push(ownership);
      }
      return ownership;
    } finally {
      await application.close();
    }
  }

  async identity(dataDir: string): Promise<Readonly<{ dev: string; ino: string }>> {
    const metadata = await stat(path.join(dataDir, '.revo-server.lock'));
    return { dev: String(metadata.dev), ino: String(metadata.ino) };
  }

  async insecureDataDir(): Promise<string> {
    const dataDir = this.dataDir();
    await mkdir(dataDir, { mode: 0o755 });
    return dataDir;
  }

  async symlinkLock(): Promise<string> {
    const dataDir = this.dataDir();
    await mkdir(dataDir, { mode: 0o700 });
    await symlink(path.join(this.root, 'target'), path.join(dataDir, '.revo-server.lock'));
    return dataDir;
  }

  async nonRegularLock(): Promise<string> {
    const dataDir = this.dataDir();
    await mkdir(dataDir, { mode: 0o700 });
    await new Promise<void>((resolveCreate, reject) => {
      execFile('mkfifo', [path.join(dataDir, '.revo-server.lock')], (error) => {
        if (error === null) {
          resolveCreate();
        } else {
          reject(error);
        }
      });
    });
    return dataDir;
  }

  processExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async spawnUnrelated(owner: OwnerProcess): Promise<number> {
    const { pid } = await owner.request('spawn-unrelated');
    const childPid = Number(pid);
    this.unrelatedChildren.push(childPid);
    return childPid;
  }

  killUnrelated(pid: number): void {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.children.map((child) => child.kill()));
    await Promise.all(this.leases.map((lease) => lease.release()));
    for (const pid of this.unrelatedChildren) {
      this.killUnrelated(pid);
    }
    await rm(this.root, { recursive: true });
  }
}
