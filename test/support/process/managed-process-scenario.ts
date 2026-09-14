import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { ProcessIdentityService } from '../../../src/processes/process-identity.service.js';
import type { ProcessIdentity } from '../../../src/processes/process-identity.types.js';
import { ProcessesModule } from '../../../src/processes/processes.module.js';

const CHILD = resolve(dirname(fileURLToPath(import.meta.url)), 'managed-child.mjs');
const RELEASE_PARENT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'managed-process-release-parent.mjs',
);

interface EnvironmentReport {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

class MissingExitObservation extends ProcessExitWaiter {
  override async wait(): Promise<boolean> {
    return false;
  }
}

export class ManagedProcessScenario {
  private readonly handles: OwnedProcess[] = [];
  private readonly unrelated: ChildProcess[] = [];
  private readonly releasedIdentities = new Map<number, ProcessIdentity>();
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

  async environment(handle: OwnedProcess): Promise<{
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  }> {
    const report: unknown = JSON.parse(await this.output(handle));
    if (!isEnvironmentReport(report)) {
      throw new Error('Expected a valid managed process environment report.');
    }
    if (process.platform === 'darwin') {
      delete report.env['__CF_USER_TEXT_ENCODING'];
    }
    return report;
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

  async detachCommitted(handle: OwnedProcess): Promise<void> {
    if (typeof handle.detachCommitted !== 'function') {
      throw new Error('Expected managed process capability detachCommitted.');
    }
    await handle.detachCommitted();
  }

  async abandonUncertain(handle: OwnedProcess): Promise<void> {
    if (typeof handle.abandonUncertain !== 'function') {
      throw new Error('Expected managed process capability abandonUncertain.');
    }
    await handle.abandonUncertain();
  }

  async ipcIsDisconnected(handle: OwnedProcess): Promise<boolean> {
    try {
      await handle.send?.({ action: 'after-release' });
      return false;
    } catch {
      return true;
    }
  }

  async releasedParentExits(transition: 'detachCommitted' | 'abandonUncertain'): Promise<{
    readonly childPid: number;
    readonly childAlive: boolean;
    readonly childGroupAlive: boolean;
  }> {
    const parent = spawn(process.execPath, [RELEASE_PARENT, transition, this.root], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.unrelated.push(parent);
    let completion: ProcessCompletion;
    let stdout: string;
    try {
      [completion, stdout] = await Promise.all([
        boundedCompletion(parent),
        streamText(parent.stdout, 'release parent stdout'),
        streamText(parent.stderr, 'release parent stderr'),
      ]);
    } catch (error) {
      await this.trackReleasedChild();
      throw error;
    }
    const childPid = Number(await readFile(path.join(this.root, 'released-child.pid'), 'utf8'));
    if (!Number.isSafeInteger(childPid) || childPid < 1) {
      throw new Error('Release parent did not publish a valid child PID.');
    }
    this.unrelatedChildren.push(childPid);
    this.releasedIdentities.set(childPid, await new ProcessIdentityService().capture(childPid));
    if (completion.exitCode !== 0 || completion.signal !== null) {
      throw new Error(
        `Release parent failed: phase=exit exitCode=${String(completion.exitCode)} signal=${String(completion.signal)}`,
      );
    }
    const report: unknown = JSON.parse(stdout);
    if (!isRecord(report) || !Number.isSafeInteger(report.pid) || Number(report.pid) < 1) {
      throw new Error('Release parent returned an invalid child identity.');
    }
    if (Number(report.pid) !== childPid) {
      throw new Error('Release parent changed child identity.');
    }
    return {
      childPid,
      childAlive: processExists(childPid),
      childGroupAlive: processExists(-childPid),
    };
  }

  signalWasObserved(): Promise<boolean> {
    return this.markerExistsAt('signal-observed');
  }

  async cleanReleasedChild(pid: number): Promise<void> {
    await writeFile(path.join(this.root, 'cleanup'), 'cleanup');
    await waitForPath(path.join(this.root, 'child-completed'));
    await waitForMissingIdentity(this.releasedIdentities.get(pid));
    this.releasedIdentities.delete(pid);
    const tracked = this.unrelatedChildren.indexOf(pid);
    if (tracked >= 0) {
      this.unrelatedChildren.splice(tracked, 1);
    }
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
      if (this.isRunning(child)) {
        child.kill('SIGKILL');
      }
    }
    await Promise.all(this.unrelated.map((child) => waitForExit(child)));
    if (this.unrelatedChildren.length > 0) {
      await writeFile(path.join(this.root, 'cleanup'), 'cleanup');
      await waitForPath(path.join(this.root, 'child-completed'));
      await Promise.all(
        this.unrelatedChildren.map((pid) =>
          waitForMissingIdentity(this.releasedIdentities.get(pid)),
        ),
      );
      this.unrelatedChildren.splice(0);
    }
    await rm(this.root, { force: true, recursive: true });
  }

  private readonly unrelatedChildren: number[] = [];

  private async markerExistsAt(name: string): Promise<boolean> {
    try {
      await stat(path.join(this.root, name));
      return true;
    } catch {
      return false;
    }
  }

  private async trackReleasedChild(): Promise<void> {
    try {
      const pid = Number(await readFile(path.join(this.root, 'released-child.pid'), 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1 || this.unrelatedChildren.includes(pid)) {
        return;
      }
      this.unrelatedChildren.push(pid);
      this.releasedIdentities.set(pid, await new ProcessIdentityService().capture(pid));
    } catch {
      // The nested parent did not publish a child that this fixture can safely identify.
    }
  }
}

function isEnvironmentReport(value: unknown): value is EnvironmentReport {
  if (!isRecord(value) || !isRecord(value.env)) {
    return false;
  }
  return (
    typeof value.cwd === 'string' &&
    Array.isArray(value.argv) &&
    value.argv.every((argument) => typeof argument === 'string') &&
    Object.values(value.env).every((entry) => typeof entry === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit) => child.once('exit', () => resolveExit()));
}

function boundedCompletion(child: ChildProcess): Promise<ProcessCompletion> {
  return new Promise((resolveCompletion, reject) => {
    const timer = setTimeout(() => reject(new Error('Release parent did not exit.')), 5_000);
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timer);
      resolveCompletion({ exitCode, signal });
    });
    child.once('error', reject);
  });
}

async function streamText(stream: NodeJS.ReadableStream | null, label: string): Promise<string> {
  if (!stream) {
    throw new Error(`Missing ${label}.`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForMissingIdentity(
  identity: ProcessIdentity | undefined,
  deadline = Date.now() + 5_000,
): Promise<void> {
  if (!identity) {
    throw new Error('Released process identity was not captured.');
  }
  const inspection = await new ProcessIdentityService().inspect(identity);
  if (inspection.kind === 'missing' || inspection.kind === 'mismatch') {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error(`Released process ${String(identity.pid)} did not exit.`);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  await waitForMissingIdentity(identity, deadline);
}

async function waitForPath(pathname: string, deadline = Date.now() + 5_000): Promise<void> {
  try {
    await stat(pathname);
    return;
  } catch {
    if (Date.now() >= deadline) {
      throw new Error(`Fixture path ${pathname} was not created.`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    await waitForPath(pathname, deadline);
  }
}
