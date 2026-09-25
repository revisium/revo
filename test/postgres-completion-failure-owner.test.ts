import { execFile, fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  ControlClientService,
  ControlDiscoveryService,
  ServerOwnershipService,
} from '../src/processes/index.js';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const ADAPTER_SOURCE = resolvePath(ROOT, 'test/support/postgres/completion-failure-processes.ts');
const HARNESS = resolvePath(ROOT, 'test/support/postgres/completion-failure-owner-child.mjs');
const TSC = resolvePath(ROOT, 'node_modules/typescript/bin/tsc');
const CLEANUP_TIMEOUT_MS = 15_000;

describe('published PostgreSQL owner after unconfirmed process completion', () => {
  it('retains the lease and control endpoint until the harness exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-completion-owner-'));
    const dataDir = join(root, 'data');
    const logDir = join(root, 'logs');
    const runtimeDir = join(root, 'runtime');
    await Promise.all(
      [dataDir, logDir, runtimeDir].map((directory) => mkdir(directory, { mode: 0o700 })),
    );
    const testRuntimeRoot = join(ROOT, '.test-runtime');
    await mkdir(testRuntimeRoot, { recursive: true });
    const testRuntime = await mkdtemp(join(testRuntimeRoot, 'completion-owner-'));
    let child: ChildProcess | undefined;
    let childExited = false;
    let cleanupError: unknown;
    let testError: unknown;

    try {
      await execFileAsync(process.execPath, [
        TSC,
        '--ignoreConfig',
        '--target',
        'ES2024',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--strict',
        '--skipLibCheck',
        '--types',
        'node',
        '--rootDir',
        dirname(ADAPTER_SOURCE),
        '--outDir',
        testRuntime,
        ADAPTER_SOURCE,
      ]);

      child = fork(HARNESS, [], {
        detached: true,
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        env: {
          ...process.env,
          REVO_TEST_DATA: dataDir,
          REVO_TEST_LOG: logDir,
          REVO_TEST_RUNTIME: runtimeDir,
          REVO_TEST_ADAPTER: join(testRuntime, 'completion-failure-processes.js'),
        },
      });
      child.once('exit', () => {
        childExited = true;
      });

      expect(await request(child, 'start', 180_000)).toMatchObject({
        kind: 'ready',
        owner: 'held',
      });
      expect(await request(child, 'fail-completion', 30_000)).toEqual({
        kind: 'completion-failed',
        physicalExitConfirmed: true,
        unhandled: 0,
      });
      expect(await request(child, 'close-owner', 15_000)).toEqual({
        kind: 'close-rejected',
        name: 'PublishedControlError',
        code: 'PUBLISHED_CONTROL_ERROR',
        phase: 'close',
        ownership: 'retained',
        cleanupFailures: [],
      });

      const busy = await new ServerOwnershipService().acquire(dataDir);
      expect(busy.kind).toBe('busy');
      const control = await new ControlDiscoveryService().read(dataDir);
      expect(control.kind).toBe('found');
      if (control.kind !== 'found') {
        throw new Error('Retained owner control record was not discoverable');
      }
      await expect(new ControlClientService().probe(control.record)).resolves.toEqual({
        kind: 'confirmed',
      });
      expect(await request(child, 'inspect')).toEqual({
        kind: 'state',
        owner: 'held',
        releaseObserved: false,
        postgresStarts: 1,
        postgresStops: 0,
        control: 'found',
        probe: 'confirmed',
        unhandled: 0,
      });
      expect(await request(child, 'close-owner')).toMatchObject({
        kind: 'close-rejected',
        ownership: 'retained',
      });
      expect(await request(child, 'inspect')).toMatchObject({
        releaseObserved: false,
        postgresStarts: 1,
        unhandled: 0,
      });

      expect(await request(child, 'shutdown-harness', CLEANUP_TIMEOUT_MS)).toEqual({
        kind: 'drained',
      });
      await waitForExit(child, CLEANUP_TIMEOUT_MS);
      await waitForProcessTreeExit(child, CLEANUP_TIMEOUT_MS);
      const recovered = await new ServerOwnershipService().acquire(dataDir);
      expect(recovered.kind).toBe('held');
      if (recovered.kind === 'held') {
        await recovered.release();
      }
    } catch (error) {
      testError = error;
      throw error;
    } finally {
      if (child && !childExited) {
        await request(child, 'shutdown-harness', CLEANUP_TIMEOUT_MS).catch((error: unknown) => {
          cleanupError = error;
        });
        if (!childExited) {
          await terminateProcessTree(child).catch((error: unknown) => {
            cleanupError ??= error;
          });
        }
        if (!childExited) {
          cleanupError ??= new Error('Completion failure owner harness did not exit');
        }
      }
      if (!child || childExited) {
        try {
          if (child?.pid && process.platform !== 'win32') {
            await waitForProcessTreeExit(child, CLEANUP_TIMEOUT_MS);
          }
          await rm(root, { recursive: true, force: true });
          await rm(testRuntime, { recursive: true, force: true });
        } catch (error) {
          cleanupError ??= error;
        }
      } else {
        cleanupError ??= new Error('Retained PostgreSQL owner fixture was not safe to remove');
      }
    }
    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError([testError, cleanupError], 'Owner scenario and cleanup failed');
    }
    if (testError !== undefined) {
      throw testError;
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }, 240_000);
});

function request(
  child: ChildProcess,
  command: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const id = `${command}-${Date.now()}-${Math.random()}`;
  return new Promise((resolveReply, rejectReply) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectReply(new Error(`Owner harness command timed out: ${command}`));
    }, timeoutMs);
    const onMessage = (message: unknown) => {
      if (!isMessage(message) || message.id !== id) {
        return;
      }
      cleanup();
      if (message.kind === 'error') {
        rejectReply(new Error(`Owner harness ${command} failed: ${String(message.message)}`));
      } else {
        resolveReply(Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'id')));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      rejectReply(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      rejectReply(new Error(`Owner harness exited before ${command}: ${code ?? signal}`));
    };
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    child.send({ id, command }, (error) => {
      if (error !== null) {
        cleanup();
        rejectReply(error);
      }
    });
  });
}

function isMessage(value: unknown): value is Record<string, unknown> & { id: string } {
  return (
    typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
  );
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      rejectExit(new Error('Owner harness did not exit after drain acknowledgement'));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit();
    };
    child.once('exit', onExit);
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
  } else {
    process.kill(-child.pid, 'SIGKILL');
  }
  await waitForExit(child, CLEANUP_TIMEOUT_MS);
  await waitForProcessTreeExit(child, CLEANUP_TIMEOUT_MS);
}

async function waitForProcessTreeExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!child.pid || process.platform === 'win32') {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (isProcessGone(error)) {
        return;
      }
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error('Owner harness process group did not exit');
    }
    // oxlint-disable-next-line no-await-in-loop -- process-group disappearance must be observed in order.
    await new Promise((done) => setTimeout(done, 25));
  }
}

function isProcessGone(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}
