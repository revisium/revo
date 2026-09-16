// oxlint-disable curly -- compact process state transitions stay bounded and explicit

import { spawn, type ChildProcess } from 'node:child_process';
import { open } from 'node:fs/promises';

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
  let state: 'not-launched' | 'running' | 'stopping' | 'closed' | 'unconfirmed' = 'not-launched';
  let outputOverflow = false;
  let stopFailure: Error | undefined;
  let stopReason: string | undefined;
  let logFailure: Error | undefined;
  let progressFinished = false;
  let cleanupListeners = (): void => undefined;
  let abortListener: (() => void) | undefined;
  const writes: Promise<void>[] = [];
  let spawnError: unknown;
  let resolveClose!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      resolveClose = resolve;
    },
  );
  let rejectStop!: (cause: Error) => void;
  const stopSignal = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  void stopSignal.catch(() => undefined);
  try {
    if (signal?.aborted) throw failure('cancelled');
    try {
      child = spawnProcess(executable, args, {
        cwd,
        env: { ...env },
        shell: false,
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw failure('spawn failed');
    }
    state = 'running';
    const launchedChild = child;
    if (launchedChild === undefined) throw failure('spawn failed');
    let stopPromise: Promise<void> | undefined;
    const stop = async (reason: string): Promise<void> => {
      if (stopPromise !== undefined) return stopPromise;
      if (state === 'closed' || state === 'unconfirmed') return;
      stopReason ??= reason;
      state = 'stopping';
      stopPromise = (async () => {
        groupSignal(launchedChild, 'SIGTERM', platform);
        const exited = await Promise.race([
          closePromise.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), policy.terminationGraceMs),
          ),
        ]);
        if (exited) return;
        groupSignal(launchedChild, 'SIGKILL', platform);
        const killed = await Promise.race([
          closePromise.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), policy.killWaitMs)),
        ]);
        if (!killed) {
          state = 'unconfirmed';
          throw failure('process completion could not be confirmed');
        }
      })();
      stopPromise.catch((cause: unknown) => {
        stopFailure = cause instanceof Error ? cause : failure('process stop failed');
        rejectStop(stopFailure);
      });
      return stopPromise;
    };
    const output = (kind: 'stdout' | 'stderr', chunk: unknown): void => {
      const streamState = kind === 'stdout' ? out : err;
      const before = streamState.bytes;
      const text = append(chunk, streamState, policy.maxDiagnosticBytes);
      if (
        streamState.bytes > policy.maxDiagnosticBytes ||
        before + Buffer.from(String(chunk)).length > policy.maxDiagnosticBytes
      ) {
        outputOverflow = true;
        void stop('diagnostic output exceeded its bound').catch(() => undefined);
      }
      writes.push(
        file
          .write(`${kind}: ${text}`)
          .catch((cause: unknown) => {
            logFailure = cause instanceof Error ? cause : failure('diagnostic log failed');
            return stop('diagnostic log failed').catch(() => undefined);
          })
          .then(() => undefined),
      );
      progress?.feed(chunk instanceof Uint8Array ? chunk : String(chunk));
    };
    const abort = () => void stop('cancelled').catch(() => undefined);
    const onError = (cause: unknown) => {
      spawnError = cause;
      void stop('spawn failed').catch(() => undefined);
    };
    const onClose = (code: number | null, closeSignal: NodeJS.Signals | null) => {
      state = 'closed';
      resolveClose({ code, signal: closeSignal });
    };
    abortListener = abort;
    child.once('error', onError);
    child.once('close', onClose);
    const stdoutListener = (chunk: unknown) => output('stdout', chunk);
    const stderrListener = (chunk: unknown) => output('stderr', chunk);
    launchedChild.stdout?.on('data', stdoutListener);
    launchedChild.stderr?.on('data', stderrListener);
    cleanupListeners = () => {
      launchedChild.removeListener('error', onError);
      launchedChild.removeListener('close', onClose);
      launchedChild.stdout?.removeListener('data', stdoutListener);
      launchedChild.stderr?.removeListener('data', stderrListener);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) void stop('cancelled').catch(() => undefined);
    timer = setTimeout(() => void stop('timed out').catch(() => undefined), policy.timeoutMs);
    const result = await Promise.race([closePromise, stopSignal]);
    await Promise.all(writes);
    progress?.finish({ exitCode: result.code, signal: result.signal });
    progressFinished = true;
    if (signal?.aborted) throw failure('cancelled');
    if (spawnError !== undefined) throw failure('spawn failed');
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
    if (abortListener !== undefined) signal?.removeEventListener('abort', abortListener);
    await file.close().catch(() => undefined);
    if (!progressFinished) progress?.finish({ exitCode: 1, signal: null });
    cleanupListeners();
  }
}

export const runManagedPackageProcess = runPackageProcess;
