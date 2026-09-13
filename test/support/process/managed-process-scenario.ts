import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NestFactory } from '@nestjs/core';

import { ManagedProcessService } from '../../../src/processes/managed-process.service.js';
import type {
  ManagedProcessRequest,
  OwnedProcess,
  ProcessCompletion,
} from '../../../src/processes/managed-process.types.js';
import { ProcessExitWaiter } from '../../../src/processes/process-exit-waiter.js';
import { ProcessesModule } from '../../../src/processes/processes.module.js';

const CHILD = resolve(dirname(fileURLToPath(import.meta.url)), 'managed-child.mjs');

class MissingExitObservation extends ProcessExitWaiter {
  override async wait(): Promise<boolean> {
    return false;
  }
}

export class ManagedProcessScenario {
  private readonly handles: OwnedProcess[] = [];
  private readonly unrelated: ChildProcess[] = [];
  private root = '';

  async setup(): Promise<this> {
    this.root = await mkdtemp(path.join(tmpdir(), 'revo-managed-process-'));
    return this;
  }

  request(
    args: readonly string[],
    overrides: Partial<ManagedProcessRequest> = {},
  ): ManagedProcessRequest {
    return {
      args: [CHILD, ...args],
      cwd: this.root,
      env: { REVO_FIXTURE: 'exact value' },
      executable: process.execPath,
      stdio: { stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' },
      ...overrides,
    };
  }

  async start(request: ManagedProcessRequest): Promise<OwnedProcess> {
    const handle = await new ManagedProcessService().start(request);
    this.handles.push(handle);
    return handle;
  }

  async startWithoutExitObservation(request: ManagedProcessRequest): Promise<OwnedProcess> {
    const handle = await new ManagedProcessService(new MissingExitObservation()).start(request);
    this.handles.push(handle);
    return handle;
  }

  async startThroughNest(request: ManagedProcessRequest): Promise<OwnedProcess> {
    const application = await NestFactory.createApplicationContext(ProcessesModule, {
      logger: false,
    });
    try {
      const handle = await application.get(ManagedProcessService).start(request);
      this.handles.push(handle);
      return handle;
    } finally {
      await application.close();
    }
  }

  async output(handle: OwnedProcess): Promise<string> {
    if (handle.stdout === undefined) {
      throw new Error('Expected piped stdout.');
    }
    const chunks: Buffer[] = [];
    for await (const chunk of handle.stdout) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async begin(handle: OwnedProcess): Promise<unknown> {
    const reply = new Promise<unknown>((resolveReply) => {
      const unsubscribe = handle.subscribe?.((message) => {
        unsubscribe?.();
        resolveReply(message);
      });
    });
    await handle.send?.({ action: 'begin' });
    return reply;
  }

  waitForMessage(handle: OwnedProcess): Promise<unknown> {
    return new Promise((resolveReply) => {
      const unsubscribe = handle.subscribe?.((message) => {
        unsubscribe?.();
        resolveReply(message);
      });
    });
  }

  markerPath(): string {
    return path.join(this.root, 'spawn marker');
  }

  async markerExists(): Promise<boolean> {
    try {
      await stat(this.markerPath());
      return true;
    } catch {
      return false;
    }
  }

  async startUnrelated(): Promise<ChildProcess> {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await new Promise<void>((resolveSpawn, reject) => {
      child.once('spawn', resolveSpawn);
      child.once('error', reject);
    });
    this.unrelated.push(child);
    return child;
  }

  isRunning(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null;
  }

  completion(handle: OwnedProcess): Promise<ProcessCompletion> {
    return handle.completion;
  }

  async read(pathname: string): Promise<string> {
    return readFile(pathname, 'utf8');
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled(
      this.handles.map((handle) =>
        new ManagedProcessService().stop(handle, { graceMs: 20, killWaitMs: 1_000 }),
      ),
    );
    for (const child of this.unrelated) {
      child.kill('SIGKILL');
    }
    await Promise.all(this.unrelated.map((child) => waitForExit(child)));
    await rm(this.root, { force: true, recursive: true });
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit) => child.once('exit', () => resolveExit()));
}
