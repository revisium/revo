// oxlint-disable curly -- compact process state transitions stay bounded and explicit

import { spawn, type ChildProcess } from 'node:child_process';
import { open, rm } from 'node:fs/promises';

import type { PnpmProgressSink } from './pnpm-progress.js';

export const DEFAULT_PACKAGE_PROCESS_POLICY = Object.freeze({
  timeoutMs: 10 * 60_000,
  terminationGraceMs: 5_000,
  killWaitMs: 5_000,
  maxDiagnosticBytes: 2 * 1024 * 1024,
});

export interface PackageProcessPolicy {
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly killWaitMs?: number;
  readonly maxDiagnosticBytes?: number;
}
export interface PackageProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly diagnosticPath: string;
  readonly stdout: string;
  readonly stderr: string;
}
type Spawned = ChildProcess;
type SpawnRequest = (command: string, args: readonly string[], options: object) => Spawned;

const failure = (reason: string): Error => new Error(`package process: ${reason}`);
const bounded = (input: PackageProcessPolicy = {}) => {
  const policy = { ...DEFAULT_PACKAGE_PROCESS_POLICY, ...input };
  if (Object.values(policy).some((value) => !Number.isSafeInteger(value) || value < 0))
    throw failure('process policy is invalid');
  if (policy.timeoutMs === 0 || policy.maxDiagnosticBytes === 0)
    throw failure('process policy is invalid');
  return policy;
};
const append = (chunk: unknown, state: { bytes: number; text: string }, limit: number): string => {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = limit - state.bytes;
  state.bytes += value.length;
  if (remaining <= 0) return '';
  const kept = value.subarray(0, remaining).toString('utf8');
  state.text += kept;
  return kept;
};
const groupSignal = (child: Spawned, signal: NodeJS.Signals, platform = process.platform): void => {
  try {
    if (platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (cause) {
    const code =
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      typeof cause.code === 'string'
        ? cause.code
        : undefined;
    if (code !== 'ESRCH') throw cause;
  }
};
const wait = (child: Spawned): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

export async function runPackageProcess /* NOSONAR -- bounded process state machine */({
  executable,
  args,
  cwd,
  env,
  diagnosticPath,
  signal,
  policy: inputPolicy,
  platform = process.platform,
  spawnProcess = (command, argv, options) => spawn(command, [...argv], options),
  progress,
}: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly diagnosticPath: string;
  readonly signal?: AbortSignal;
  readonly policy?: PackageProcessPolicy;
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: SpawnRequest;
  readonly progress?: PnpmProgressSink;
}): Promise<PackageProcessResult> {
  if (!executable.startsWith('/') || !cwd.startsWith('/') || !diagnosticPath.startsWith('/'))
    throw failure('absolute paths are required');
  if (signal?.aborted) throw failure('cancelled before launch');
  const policy = bounded(inputPolicy);
  const file = await open(diagnosticPath, 'wx', 0o600).catch(() => {
    throw failure('diagnostic log cannot be created exclusively');
  });
  const out = { bytes: 0, text: '' };
  const err = { bytes: 0, text: '' };
  let child: Spawned | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;
  let outputOverflow = false;
  let stopFailure: Error | undefined;
  let stopReason: string | undefined;
  let logFailure: Error | undefined;
  let progressFinished = false;
  try {
    child = spawnProcess(executable, args, {
      cwd,
      env: { ...env },
      shell: false,
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stopProcess: ((reason: string) => Promise<void>) | undefined;
    const output = (kind: 'stdout' | 'stderr', chunk: unknown): void => {
      const state = kind === 'stdout' ? out : err;
      const before = state.bytes;
      const text = append(chunk, state, policy.maxDiagnosticBytes);
      if (
        state.bytes > policy.maxDiagnosticBytes ||
        before + Buffer.from(String(chunk)).length > policy.maxDiagnosticBytes
      ) {
        outputOverflow = true;
        void (stopProcess?.('diagnostic output exceeded its bound') ?? Promise.resolve()).catch(
          (cause: unknown) => {
            stopFailure = cause instanceof Error ? cause : failure('process stop failed');
          },
        );
      }
      void file.write(`${kind}: ${text}`).catch((cause: unknown) => {
        logFailure = cause instanceof Error ? cause : failure('diagnostic log failed');
        void (stopProcess?.('diagnostic log failed') ?? Promise.resolve()).catch(
          (error_: unknown) => {
            stopFailure = error_ instanceof Error ? error_ : failure('process stop failed');
          },
        );
      });
      progress?.feed(chunk instanceof Uint8Array ? chunk : String(chunk));
    };
    child.stdout?.on('data', (chunk) => output('stdout', chunk));
    child.stderr?.on('data', (chunk) => output('stderr', chunk));
    const completion = wait(child);
    const stop = async (reason: string): Promise<void> => {
      if (stopping || child === undefined) return;
      stopping = true;
      stopReason = reason;
      groupSignal(child, 'SIGTERM', platform);
      const exited = await Promise.race([
        completion.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), policy.terminationGraceMs),
        ),
      ]);
      if (!exited) {
        groupSignal(child, 'SIGKILL', platform);
        await Promise.race([
          completion,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(failure(`${reason}; process did not drain`)),
              policy.killWaitMs,
            ),
          ),
        ]);
      }
    };
    stopProcess = stop;
    const abort = () =>
      void stop('cancelled').catch((cause: unknown) => {
        stopFailure = cause instanceof Error ? cause : failure('process stop failed');
      });
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(
      () =>
        void stop('timed out').catch((cause: unknown) => {
          stopFailure = cause instanceof Error ? cause : failure('process stop failed');
        }),
      policy.timeoutMs,
    );
    const result = await completion.catch((cause) => {
      progress?.finish({ exitCode: 1, signal: null });
      progressFinished = true;
      throw failure(cause instanceof Error ? cause.message : 'spawn failed');
    });
    progress?.finish({ exitCode: result.code, signal: result.signal });
    progressFinished = true;
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) throw failure('cancelled');
    if (outputOverflow) throw failure('diagnostic output exceeded its bound');
    if (logFailure !== undefined) throw logFailure;
    if (stopFailure !== undefined) throw stopFailure;
    if (stopReason !== undefined) throw failure(stopReason);
    return {
      exitCode: result.code,
      signal: result.signal,
      diagnosticPath,
      stdout: out.text,
      stderr: err.text,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await file.close().catch(() => undefined);
    if (!progressFinished) progress?.finish({ exitCode: 1, signal: null });
    if (child === undefined) await rm(diagnosticPath, { force: true }).catch(() => undefined);
  }
}

export const runManagedPackageProcess = runPackageProcess;
