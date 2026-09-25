import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  createBoundedProgressObserver,
  createObservedSpawn,
  isSafeDriverMessage,
  observeSpawnedChild,
  readInstallLogSnapshot,
} from './pnpm-install-diagnostic-support.mjs';

const MAX_ORDINARY_RECORDS = 14;
const MAX_ORDINARY_BYTES = 6_144;
const MAX_TOTAL_RECORDS = 16;
const MAX_TOTAL_BYTES = 8 * 1024;
const MAX_ORDINARY_MESSAGE_BYTES = 2_048;
const MAX_COMPLETION_MESSAGE_BYTES = 1_536;
const MAX_RESULT_MESSAGE_BYTES = 512;
const INSTALL_ARGS = Object.freeze([
  'install',
  '--prod',
  '--frozen-lockfile',
  '--reporter=ndjson',
  '--store-dir',
  'channel-local',
  '--pm-on-fail=error',
  '--config.strict-dep-builds=true',
  '--config.verify-store-integrity=true',
]);
const startedAt = performance.now();
const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
const own = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const safeErrorCode = (value) => {
  const allowed = new Set([
    'EACCES',
    'EEXIST',
    'EINTR',
    'EINVAL',
    'EIO',
    'EMFILE',
    'ENOENT',
    'ENOSPC',
    'EPERM',
    'EPIPE',
    'ESRCH',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'UND_ERR_ABORTED',
  ]);
  return typeof value === 'string' && allowed.has(value) ? value : 'other';
};

function parseInput(raw) {
  if (typeof raw !== 'string' || raw.length > 4_096) {
    throw new Error('invalid input');
  }
  const input = JSON.parse(raw);
  const inputKeys = ['moduleUrl', 'nodeExecutable', 'pnpmExecutable', 'stage'];
  if (
    !own(input) ||
    Object.keys(input).length !== inputKeys.length ||
    Object.keys(input).some((key) => !inputKeys.includes(key)) ||
    typeof input.moduleUrl !== 'string' ||
    !input.moduleUrl.startsWith('file:') ||
    typeof input.nodeExecutable !== 'string' ||
    !isAbsolute(input.nodeExecutable) ||
    typeof input.pnpmExecutable !== 'string' ||
    !isAbsolute(input.pnpmExecutable) ||
    !own(input.stage) ||
    Object.keys(input.stage).length !== 3 ||
    Object.keys(input.stage).some(
      (key) => !['directory', 'packageDirectory', 'version'].includes(key),
    ) ||
    typeof input.stage.directory !== 'string' ||
    !isAbsolute(input.stage.directory) ||
    typeof input.stage.packageDirectory !== 'string' ||
    !isAbsolute(input.stage.packageDirectory) ||
    typeof input.stage.version !== 'string' ||
    input.stage.directory !== input.stage.packageDirectory
  ) {
    throw new Error('invalid input');
  }
  return input;
}

let observerIncomplete = false;
let ordinaryRecords = 0;
let ordinaryBytes = 0;
let totalRecords = 0;
let totalBytes = 0;
let senderQueue = Promise.resolve();
let terminalSent = false;
let completionSnapshotSent = false;
let ordinaryIntakeOpen = true;
let acceptingSnapshots = true;
let finished = false;
let controller;
let abortReceived = false;
let input;
let progress;
let observer;
let childMonitor;
let packageModule;
let spawnSeen = false;
let closeSeen = false;
let exitCode = null;
let exitSignal = null;
let stderrBytes = 0;
let previousLogTail;
let snapshotIds = new Set();
let snapshotQueue = Promise.resolve();

function send(message, reservation = 'ordinary') {
  try {
    if (!isSafeDriverMessage(message)) {
      observerIncomplete = true;
      return Promise.resolve(false);
    }
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (message.type === 'result') {
      if (reservation !== 'terminal' || terminalSent || bytes > MAX_RESULT_MESSAGE_BYTES) {
        observerIncomplete = true;
        return Promise.resolve(false);
      }
      terminalSent = true;
    } else if (terminalSent) {
      observerIncomplete = true;
      return Promise.resolve(false);
    } else if (reservation === 'completion') {
      if (
        message.type !== 'snapshot' ||
        message.id !== 6 ||
        completionSnapshotSent ||
        bytes > MAX_COMPLETION_MESSAGE_BYTES
      ) {
        observerIncomplete = true;
        return Promise.resolve(false);
      }
      completionSnapshotSent = true;
    } else if (reservation === 'ordinary') {
      if (
        !ordinaryIntakeOpen ||
        ordinaryRecords >= MAX_ORDINARY_RECORDS ||
        bytes > MAX_ORDINARY_MESSAGE_BYTES ||
        ordinaryBytes + bytes > MAX_ORDINARY_BYTES
      ) {
        observerIncomplete = true;
        ordinaryIntakeOpen = false;
        return Promise.resolve(false);
      }
      ordinaryRecords += 1;
      ordinaryBytes += bytes;
    } else {
      observerIncomplete = true;
      return Promise.resolve(false);
    }
    if (totalRecords >= MAX_TOTAL_RECORDS || totalBytes + bytes > MAX_TOTAL_BYTES) {
      observerIncomplete = true;
      return Promise.resolve(false);
    }
    totalRecords += 1;
    totalBytes += bytes;
    const next = senderQueue.then(
      () =>
        new Promise((resolve) => {
          if (typeof process.send !== 'function' || !process.connected) {
            observerIncomplete = true;
            resolve(false);
            return;
          }
          process.send(message, (cause) => {
            if (cause) {
              observerIncomplete = true;
            }
            resolve(cause === null || cause === undefined);
          });
        }),
    );
    senderQueue = next.then(
      () => undefined,
      () => {
        observerIncomplete = true;
      },
    );
    return next;
  } catch {
    observerIncomplete = true;
    return Promise.resolve(false);
  }
}

async function sendSnapshot(id, reservation = 'ordinary') {
  const path = join(input.stage.packageDirectory, '.package-install.log');
  const log = await readInstallLogSnapshot(path, previousLogTail, input.stage.packageDirectory);
  previousLogTail = log.tailDigest;
  const metrics = progress.snapshot();
  const activity = metrics.activity.slice(0, 16);
  const errorCodes = metrics.errorCodes.slice(0, 8);
  const message = {
    type: 'snapshot',
    id,
    atMs: elapsed(),
    stdoutBytes: metrics.stdoutBytes,
    stderrBytes,
    logSafe: log.safe,
    logState: log.safe ? 'safe' : log.reason,
    ...(log.safe
      ? {
          logSize: log.size,
          tailChanged: log.tailChanged,
          activity,
          lastActivityMs: metrics.lastActivityMs,
          errorCodes,
          malformedLines: metrics.malformedLines,
          droppedLines:
            metrics.droppedLines +
            metrics.activity.length -
            activity.length +
            metrics.errorCodes.length -
            errorCodes.length,
        }
      : {}),
  };
  await send(message, reservation);
}

function onControl(message) {
  try {
    if (!own(message)) {
      throw new Error('invalid control');
    }
    if (message.type === 'abort' && Object.keys(message).length === 1) {
      if (abortReceived || finished) {
        throw new Error('duplicate abort');
      }
      abortReceived = true;
      controller.abort();
      void send({ type: 'event', name: 'abort-received', atMs: elapsed() });
      return;
    }
    if (
      message.type === 'snapshot' &&
      Object.keys(message).length === 2 &&
      Number.isInteger(message.id) &&
      message.id >= 0 &&
      message.id <= 5 &&
      !snapshotIds.has(message.id) &&
      acceptingSnapshots &&
      !finished
    ) {
      snapshotIds.add(message.id);
      snapshotQueue = snapshotQueue
        .then(() => sendSnapshot(message.id))
        .catch(() => {
          observerIncomplete = true;
        });
      return;
    }
    throw new Error('invalid control');
  } catch {
    observerIncomplete = true;
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
  }
}

function childEvent(event) {
  if (event.name === 'spawn') {
    spawnSeen = true;
  }
  if (event.name === 'exit') {
    exitCode = event.code;
    exitSignal = event.signal;
  }
  if (event.name === 'close') {
    closeSeen = true;
    exitCode = event.code;
    exitSignal = event.signal;
  }
  const { name, atMs, code, signal, errorCode } = event;
  const message = {
    type: 'event',
    name,
    atMs,
    ...(name === 'exit' || name === 'close' ? { code, signal } : {}),
    ...(name === 'spawn-error' ? { errorCode: errorCode ?? 'other' } : {}),
  };
  void send(message);
}

function classifyResult(cause, success) {
  const summary = observer?.summary();
  const childState = childMonitor?.snapshot();
  observerIncomplete ||=
    summary?.observerIncomplete === true ||
    childState?.observerIncomplete === true ||
    (success && (summary?.calls !== 1 || summary?.matches !== 1 || !spawnSeen || !closeSeen));
  const result = success
    ? { exitCode: cause.process.exitCode, signal: cause.process.signal }
    : {
        ...(Number.isSafeInteger(cause?.result?.exitCode) || cause?.result?.exitCode === null
          ? { exitCode: cause.result.exitCode }
          : exitCode !== null
            ? { exitCode }
            : {}),
        ...(cause?.result?.signal !== undefined
          ? { signal: cause.result.signal }
          : exitSignal !== null
            ? { signal: exitSignal }
            : {}),
        ...(typeof cause?.code === 'string' ? { errorCode: safeErrorCode(cause.code) } : {}),
      };
  const outcome = observerIncomplete
    ? 'observer-incomplete'
    : success
      ? 'success'
      : 'install-error';
  if (outcome === 'success' && (result.exitCode !== 0 || result.signal !== null)) {
    observerIncomplete = true;
  }
  return {
    type: 'result',
    outcome: observerIncomplete ? 'observer-incomplete' : outcome,
    atMs: elapsed(),
    stdoutBytes: progress.snapshot().stdoutBytes,
    stderrBytes,
    observerIncomplete,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  };
}

async function main() {
  let inputError = false;
  try {
    input = parseInput(process.argv[2]);
  } catch {
    inputError = true;
  }
  if (inputError) {
    await send(
      {
        type: 'result',
        outcome: 'driver-error',
        atMs: elapsed(),
        stdoutBytes: 0,
        stderrBytes: 0,
        observerIncomplete: true,
      },
      'terminal',
    );
    return;
  }

  controller = new AbortController();
  process.on('message', onControl);
  process.once('disconnect', () => {
    if (!finished && !controller.signal.aborted) {
      observerIncomplete = true;
      controller.abort();
    }
  });
  process.once('SIGTERM', () => {
    if (!finished && !controller.signal.aborted) {
      observerIncomplete = true;
      controller.abort();
    }
  });
  progress = createBoundedProgressObserver(() => elapsed());
  const expected = {
    executable: input.pnpmExecutable,
    args: INSTALL_ARGS,
    cwd: input.stage.packageDirectory,
  };
  const originalSpawn = childProcess.spawn;
  observer = createObservedSpawn({
    original: originalSpawn,
    expected,
    observeChild(child) {
      if (!child) {
        childEvent({ name: 'spawn-error', atMs: elapsed(), errorCode: 'other' });
        return;
      }
      childMonitor = observeSpawnedChild(child, {
        now: elapsed,
        onStderr(chunk) {
          const length =
            chunk instanceof Uint8Array ? chunk.byteLength : Buffer.byteLength(String(chunk));
          stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + length);
          progress.addStderr(chunk);
        },
        onEvent: childEvent,
      });
    },
  });
  childProcess.spawn = observer.spawn;
  syncBuiltinESMExports();
  try {
    packageModule = await import(input.moduleUrl);
    if (
      JSON.stringify(packageModule.PACKAGE_INSTALL_ARGS) !== JSON.stringify(INSTALL_ARGS) ||
      typeof packageModule.installPackage !== 'function'
    ) {
      throw new Error('compiled installer contract mismatch');
    }
    await send({ type: 'event', name: 'ready', atMs: elapsed() });
  } catch {
    observerIncomplete = true;
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    await send(
      {
        type: 'result',
        outcome: 'driver-error',
        atMs: elapsed(),
        stdoutBytes: 0,
        stderrBytes: 0,
        observerIncomplete: true,
      },
      'terminal',
    );
    return;
  }

  let installResult;
  let installError;
  try {
    installResult = await packageModule.installPackage({
      stage: input.stage,
      pnpmExecutable: input.pnpmExecutable,
      nodeExecutable: input.nodeExecutable,
      diagnosticPath: join(input.stage.packageDirectory, '.package-install.log'),
      signal: controller.signal,
      progress: {
        feed(chunk) {
          progress.feed(chunk);
        },
        finish() {
          progress.finish();
        },
      },
    });
  } catch (cause) {
    installError = cause;
  }
  progress.finish();
  acceptingSnapshots = false;
  await snapshotQueue;
  await senderQueue;
  if (spawnSeen || closeSeen) {
    await sendSnapshot(6, 'completion').catch(() => {
      observerIncomplete = true;
    });
  }
  await senderQueue;
  childProcess.spawn = originalSpawn;
  try {
    syncBuiltinESMExports();
  } catch {
    observerIncomplete = true;
  }
  finished = true;
  const result = classifyResult(installError ?? installResult, installError === undefined);
  await send(result, 'terminal');
  await senderQueue;
}

main()
  .catch(async () => {
    observerIncomplete = true;
    finished = true;
    if (observer?.original) {
      childProcess.spawn = observer.original;
      try {
        syncBuiltinESMExports();
      } catch {
        /* terminal failure is recorded below */
      }
    }
    if (!terminalSent) {
      await send(
        {
          type: 'result',
          outcome: 'driver-error',
          atMs: elapsed(),
          stdoutBytes: 0,
          stderrBytes,
          observerIncomplete: true,
        },
        'terminal',
      );
    }
    await senderQueue;
  })
  .finally(() => {
    if (process.connected) {
      process.disconnect();
    }
  });
