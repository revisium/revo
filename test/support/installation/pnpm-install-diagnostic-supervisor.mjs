import { fork } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  boundedDiagnosticReport,
  createDiagnosticSchedule,
  isSafeDriverMessage,
} from './pnpm-install-diagnostic-support.mjs';

export const DEFAULT_INSTALL_DIAGNOSTIC_LIMITS = Object.freeze({
  readyTimeoutMs: 30_000,
  spawnTimeoutMs: 60_000,
  snapshotAtMs: Object.freeze([30_000, 60_000, 120_000, 180_000, 300_000, 540_000]),
  abortAtMs: 600_000,
  teardownMs: 10_000,
  forceWaitMs: 2_000,
  driverCloseTimeoutMs: 10_000,
  maxMessageBytes: 2_048,
  maxRecords: 16,
  maxLedgerBytes: 8_192,
});

const own = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const enumFallbacks = new Set([
  'invalid-input',
  'driver-spawn-failed',
  'driver-ready-deadline',
  'pnpm-spawn-deadline',
  'invalid-driver-message',
  'driver-report-budget-exceeded',
  'duplicate-driver-event',
  'driver-event-order-invalid',
  'pnpm-spawn-order-invalid',
  'spawn-error-order-invalid',
  'exit-without-spawn',
  'close-without-spawn-or-error',
  'unsolicited-abort-ack',
  'snapshot-order-invalid',
  'result-order-invalid',
  'completion-snapshot-missing',
  'post-result-message',
  'driver-message-processing-failed',
  'driver-process-error',
  'driver-disconnected-before-result',
  'driver-closed-before-result',
  'driver-close-after-result-deadline',
  'control-channel-unavailable',
  'control-send-failed',
  'snapshot-send-failed',
  'abort-send-failed',
  'teardown-deadline',
  'bounded-report-overflow',
  'terminal-contract-invalid',
  'driver-exit-close-mismatch',
  'terminal-timeout',
  'post-completion-message',
]);

function limitsFor(input = {}) {
  if (!own(input)) {
    throw new Error('diagnostic supervisor limits are invalid');
  }
  const expected = Object.keys(DEFAULT_INSTALL_DIAGNOSTIC_LIMITS);
  if (Object.keys(input).some((key) => !expected.includes(key))) {
    throw new Error('diagnostic supervisor limits are invalid');
  }
  const limits = { ...DEFAULT_INSTALL_DIAGNOSTIC_LIMITS, ...input };
  for (const key of [
    'readyTimeoutMs',
    'spawnTimeoutMs',
    'abortAtMs',
    'teardownMs',
    'forceWaitMs',
    'driverCloseTimeoutMs',
    'maxMessageBytes',
    'maxRecords',
    'maxLedgerBytes',
  ]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > 1_200_000) {
      throw new Error('diagnostic supervisor limits are invalid');
    }
  }
  if (
    !Array.isArray(limits.snapshotAtMs) ||
    limits.snapshotAtMs.length > 6 ||
    limits.snapshotAtMs.some(
      (value) => !Number.isSafeInteger(value) || value < 1 || value >= limits.abortAtMs,
    ) ||
    [...limits.snapshotAtMs]
      .sort((left, right) => left - right)
      .some((value, index, sorted) => index > 0 && value === sorted[index - 1])
  ) {
    throw new Error('diagnostic supervisor limits are invalid');
  }
  return limits;
}

function projectEvent(message) {
  const base = { name: message.name, atMs: message.atMs };
  if (message.name === 'exit' || message.name === 'close') {
    return { ...base, code: message.code, signal: message.signal };
  }
  if (message.name === 'spawn-error') {
    return { ...base, errorCode: message.errorCode };
  }
  return base;
}

function projectSnapshot(message) {
  if (!message.logSafe) {
    return {
      id: message.id,
      atMs: message.atMs,
      stdoutBytes: message.stdoutBytes,
      stderrBytes: message.stderrBytes,
      logSafe: false,
      logState: message.logState,
    };
  }
  return {
    id: message.id,
    atMs: message.atMs,
    stdoutBytes: message.stdoutBytes,
    stderrBytes: message.stderrBytes,
    logSafe: true,
    logState: 'safe',
    logSize: message.logSize,
    tailChanged: message.tailChanged,
    activity: message.activity.map(({ name, count }) => ({ name, count })),
    lastActivityMs: message.lastActivityMs,
    errorCodes: message.errorCodes.map(({ code, count }) => ({ code, count })),
    malformedLines: message.malformedLines,
    droppedLines: message.droppedLines,
  };
}

function projectResult(message) {
  return {
    outcome: message.outcome,
    atMs: message.atMs,
    stdoutBytes: message.stdoutBytes,
    stderrBytes: message.stderrBytes,
    observerIncomplete: message.observerIncomplete,
    ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
    ...(message.signal === undefined ? {} : { signal: message.signal }),
    ...(message.errorCode === undefined ? {} : { errorCode: message.errorCode }),
  };
}

function sameStatus(leftCode, leftSignal, rightCode, rightSignal) {
  return leftCode === rightCode && leftSignal === rightSignal;
}

export function superviseInstallDiagnostic({
  driverPath,
  input,
  environment,
  limits: inputLimits,
} = {}) {
  const limits = limitsFor(inputLimits);
  let inputBytes = Infinity;
  try {
    inputBytes = Buffer.byteLength(JSON.stringify(input));
  } catch {
    /* invalid input */
  }
  if (
    typeof driverPath !== 'string' ||
    !isAbsolute(driverPath) ||
    !own(input) ||
    inputBytes > 4_096 ||
    typeof input.nodeExecutable !== 'string' ||
    !isAbsolute(input.nodeExecutable) ||
    !own(environment) ||
    Object.values(environment).some((value) => typeof value !== 'string')
  ) {
    return Promise.resolve({
      schema: 'revo-pnpm-install-diagnostic/v1',
      state: 'terminal',
      outcome: 'driver-error',
      cleanupConfirmed: false,
      sandboxStoppedConfirmed: false,
      fallback: 'invalid-input',
    });
  }

  return new Promise((resolve) => {
    const startedAt = performance.now();
    const events = [];
    const snapshots = [];
    const eventNames = new Set();
    const snapshotIds = new Set();
    let state = 'starting';
    let child;
    let result;
    let fallback;
    let fallbackStarted = false;
    let abortRequested = false;
    let abortSent = false;
    let abortReceived = false;
    let pnpmSpawnSeen = false;
    let pnpmSpawnErrorSeen = false;
    let pnpmExitSeen = false;
    let pnpmCloseSeen = false;
    let pnpmExitCode = null;
    let pnpmExitSignal = null;
    let pnpmCloseCode = null;
    let pnpmCloseSignal = null;
    let driverExitSeen = false;
    let driverCloseSeen = false;
    let driverExitCode = null;
    let driverExitSignal = null;
    let driverCloseCode = null;
    let driverCloseSignal = null;
    let ledgerBytes = 0;
    let ledgerRecords = 0;
    let ordinaryBytes = 0;
    let ordinaryRecords = 0;
    let completionSnapshotSeen = false;
    let terminalResultSeen = false;
    let terminal = false;
    let schedule;
    let startupTimer;
    let spawnTimer;
    let closeTimer;
    let fallbackTimer;
    let forceTimer;
    let finalForceTimer;
    let onMessage;
    let onError;
    let onExit;
    let onClose;
    let onDisconnect;

    const report = (forced = false) => {
      if (terminal) {
        return;
      }
      const driverStatusConsistent =
        driverExitSeen &&
        driverCloseSeen &&
        sameStatus(driverExitCode, driverExitSignal, driverCloseCode, driverCloseSignal);
      const pnpmStatusConsistent =
        pnpmExitSeen &&
        pnpmCloseSeen &&
        sameStatus(pnpmExitCode, pnpmExitSignal, pnpmCloseCode, pnpmCloseSignal);
      const spawnFailureSettled = !pnpmSpawnSeen && pnpmSpawnErrorSeen && pnpmCloseSeen;
      const resultMatchesPnpm =
        result !== undefined &&
        pnpmCloseSeen &&
        (result.exitCode === undefined || result.exitCode === pnpmCloseCode) &&
        (result.signal === undefined || result.signal === pnpmCloseSignal);
      const successfulProduct =
        result?.outcome === 'success' &&
        pnpmSpawnSeen &&
        pnpmStatusConsistent &&
        pnpmCloseCode === 0 &&
        pnpmCloseSignal === null &&
        result.exitCode === 0 &&
        result.signal === null &&
        snapshotIds.has(6);
      const acceptableFailureCleanup =
        result?.outcome === 'install-error' &&
        resultMatchesPnpm &&
        (pnpmStatusConsistent || spawnFailureSettled);
      const cleanupConfirmed =
        !forced &&
        fallback === undefined &&
        driverStatusConsistent &&
        driverExitCode === 0 &&
        driverExitSignal === null &&
        result !== undefined &&
        result.observerIncomplete === false &&
        (successfulProduct || acceptableFailureCleanup);
      let outcome = result?.outcome ?? 'observer-incomplete';
      if (
        fallback !== undefined ||
        forced ||
        result === undefined ||
        (result.outcome === 'success' && !cleanupConfirmed) ||
        (result.outcome === 'install-error' && !cleanupConfirmed)
      ) {
        outcome = 'observer-incomplete';
      }
      let value;
      try {
        value = boundedDiagnosticReport({
          schema: 'revo-pnpm-install-diagnostic/v1',
          state: 'terminal',
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          outcome,
          ...(result === undefined ? {} : { result }),
          events,
          snapshots,
          pnpmSpawnSeen,
          pnpmSpawnErrorSeen,
          pnpmExitSeen,
          pnpmCloseSeen,
          abortRequested,
          abortSent,
          abortReceived,
          driverExitSeen,
          driverCloseSeen,
          driverExitCode,
          driverExitSignal,
          driverStatusConsistent,
          pnpmStatusConsistent: pnpmSpawnSeen ? pnpmStatusConsistent : null,
          cleanupConfirmed,
          sandboxStoppedConfirmed: false,
          ...(fallback === undefined ? {} : { fallback }),
        });
      } catch {
        fallback ??= 'bounded-report-overflow';
        value = {
          schema: 'revo-pnpm-install-diagnostic/v1',
          state: 'terminal',
          outcome: 'observer-incomplete',
          cleanupConfirmed: false,
          sandboxStoppedConfirmed: false,
          fallback: 'bounded-report-overflow',
        };
      }
      terminal = true;
      state = 'terminal';
      schedule?.finish();
      clearTimeout(startupTimer);
      clearTimeout(spawnTimer);
      clearTimeout(closeTimer);
      clearTimeout(fallbackTimer);
      clearTimeout(forceTimer);
      clearTimeout(finalForceTimer);
      child?.removeListener('message', onMessage);
      child?.removeListener('error', onError);
      child?.removeListener('exit', onExit);
      child?.removeListener('close', onClose);
      child?.removeListener('disconnect', onDisconnect);
      resolve(value);
    };

    const sendControl = (message, callback = () => undefined) => {
      if (terminal || !child?.connected) {
        callback(false);
        requestFallback('control-channel-unavailable');
        return;
      }
      try {
        child.send(message, (cause) => {
          const ok = cause === null || cause === undefined;
          callback(ok);
          if (!ok) {
            requestFallback('control-send-failed');
          }
        });
      } catch {
        callback(false);
        requestFallback('control-send-failed');
      }
    };

    const requestFallback = (reason) => {
      if (terminal) {
        return;
      }
      fallback ??= enumFallbacks.has(reason) ? reason : 'terminal-contract-invalid';
      if (fallbackStarted) {
        return;
      }
      fallbackStarted = true;
      state = 'fallback';
      schedule?.finish();
      const abortWasAlreadyRequested = abortRequested;
      if (pnpmSpawnSeen && !abortRequested) {
        abortRequested = true;
        sendControl({ type: 'abort' }, (ok) => {
          abortSent = ok;
        });
      }
      fallbackTimer = setTimeout(
        () => {
          if (driverExitSeen && driverCloseSeen) {
            report(true);
            return;
          }
          try {
            child?.kill('SIGTERM');
          } catch {
            /* exact owned driver handle */
          }
          forceTimer = setTimeout(() => {
            if (!driverCloseSeen) {
              try {
                child?.kill('SIGKILL');
              } catch {
                /* exact owned driver handle */
              }
            }
            finalForceTimer = setTimeout(() => report(true), limits.forceWaitMs);
          }, limits.forceWaitMs);
        },
        pnpmSpawnSeen && !abortWasAlreadyRequested ? limits.teardownMs : limits.forceWaitMs,
      );
    };

    const maybeComplete = () => {
      if (terminal) {
        return;
      }
      if (result !== undefined && driverExitSeen && driverCloseSeen) {
        if (!sameStatus(driverExitCode, driverExitSignal, driverCloseCode, driverCloseSignal)) {
          requestFallback('driver-exit-close-mismatch');
        } else {
          report();
        }
        return;
      }
      if (driverCloseSeen && result === undefined) {
        requestFallback('driver-closed-before-result');
        return;
      }
      if (result !== undefined && closeTimer === undefined) {
        closeTimer = setTimeout(
          () => requestFallback('driver-close-after-result-deadline'),
          limits.driverCloseTimeoutMs,
        );
      }
    };

    const protocolFailure = (reason) => requestFallback(reason);

    onMessage = (message) => {
      if (terminal) {
        return;
      }
      try {
        if (!isSafeDriverMessage(message)) {
          protocolFailure('invalid-driver-message');
          return;
        }
        const messageBytes = Buffer.byteLength(JSON.stringify(message));
        ledgerRecords += 1;
        ledgerBytes += messageBytes;
        const completionSnapshot = message.type === 'snapshot' && message.id === 6;
        const terminalResult = message.type === 'result';
        if (terminalResultSeen) {
          protocolFailure('post-result-message');
          return;
        }
        if (completionSnapshot) {
          if (completionSnapshotSeen || messageBytes > 1_536) {
            protocolFailure('driver-report-budget-exceeded');
            return;
          }
          completionSnapshotSeen = true;
        } else if (terminalResult) {
          if (terminalResultSeen || messageBytes > 512) {
            protocolFailure('driver-report-budget-exceeded');
            return;
          }
          terminalResultSeen = true;
        } else {
          ordinaryBytes += messageBytes;
          ordinaryRecords += 1;
        }
        if (
          messageBytes > limits.maxMessageBytes ||
          ledgerRecords > limits.maxRecords ||
          ledgerBytes > limits.maxLedgerBytes ||
          ordinaryBytes > 6_144 ||
          ordinaryRecords > 14
        ) {
          protocolFailure('driver-report-budget-exceeded');
          return;
        }
        if (state === 'completing' && !terminalResult) {
          protocolFailure('post-completion-message');
          return;
        }
        if (message.type === 'event') {
          if (eventNames.has(message.name)) {
            protocolFailure('duplicate-driver-event');
            return;
          }
          if (message.name === 'ready') {
            if (state !== 'starting') {
              protocolFailure('driver-event-order-invalid');
              return;
            }
            state = 'ready';
            clearTimeout(startupTimer);
            spawnTimer = setTimeout(
              () => protocolFailure('pnpm-spawn-deadline'),
              limits.spawnTimeoutMs,
            );
          } else if (message.name === 'spawn') {
            if (state !== 'ready' || pnpmSpawnSeen || pnpmSpawnErrorSeen) {
              protocolFailure('pnpm-spawn-order-invalid');
              return;
            }
            state = 'running';
            pnpmSpawnSeen = true;
            clearTimeout(spawnTimer);
            schedule = createDiagnosticSchedule({
              sendSnapshot(id) {
                sendControl({ type: 'snapshot', id });
              },
              sendAbort() {
                abortRequested = true;
                state = 'aborting';
                sendControl({ type: 'abort' }, (ok) => {
                  abortSent = ok;
                });
              },
              onFallback: protocolFailure,
              snapshotAtMs: limits.snapshotAtMs,
              abortAtMs: limits.abortAtMs,
              teardownMs: limits.teardownMs,
            });
            schedule.start();
          } else if (message.name === 'spawn-error') {
            if (state !== 'ready' && state !== 'running') {
              protocolFailure('spawn-error-order-invalid');
              return;
            }
            pnpmSpawnErrorSeen = true;
          } else if (message.name === 'exit') {
            if (!pnpmSpawnSeen || pnpmExitSeen) {
              protocolFailure('exit-without-spawn');
              return;
            }
            pnpmExitSeen = true;
            pnpmExitCode = message.code;
            pnpmExitSignal = message.signal;
          } else if (message.name === 'close') {
            if ((!pnpmSpawnSeen && !pnpmSpawnErrorSeen) || pnpmCloseSeen) {
              protocolFailure('close-without-spawn-or-error');
              return;
            }
            pnpmCloseSeen = true;
            pnpmCloseCode = message.code;
            pnpmCloseSignal = message.signal;
            if (pnpmSpawnSeen && !pnpmExitSeen) {
              protocolFailure('terminal-contract-invalid');
              return;
            }
          } else if (message.name === 'abort-received') {
            if (!abortRequested || abortReceived) {
              protocolFailure('unsolicited-abort-ack');
              return;
            }
            abortReceived = true;
          } else if (message.name === 'observer-error') {
            protocolFailure('terminal-contract-invalid');
            return;
          }
          eventNames.add(message.name);
          events.push(projectEvent(message));
        } else if (message.type === 'snapshot') {
          if (
            !pnpmSpawnSeen ||
            state === 'completing' ||
            snapshotIds.has(message.id) ||
            (message.id === 6 && !pnpmCloseSeen) ||
            snapshots.length >= 7
          ) {
            protocolFailure('snapshot-order-invalid');
            return;
          }
          snapshotIds.add(message.id);
          snapshots.push(projectSnapshot(message));
          if (message.id === 6) {
            state = 'completing';
          }
        } else if (message.type === 'result') {
          const earlyDriverError =
            state === 'starting' &&
            message.outcome === 'driver-error' &&
            message.observerIncomplete;
          if (
            (state === 'starting' && !earlyDriverError) ||
            result !== undefined ||
            (pnpmSpawnSeen && !pnpmCloseSeen) ||
            (message.outcome === 'success' &&
              (!pnpmSpawnSeen ||
                !pnpmExitSeen ||
                !pnpmCloseSeen ||
                pnpmCloseCode !== 0 ||
                pnpmCloseSignal !== null ||
                !snapshotIds.has(6) ||
                message.exitCode !== 0 ||
                message.signal !== null ||
                message.observerIncomplete))
          ) {
            protocolFailure('result-order-invalid');
            return;
          }
          if (message.outcome === 'success' && !snapshotIds.has(6)) {
            protocolFailure('completion-snapshot-missing');
            return;
          }
          if (
            pnpmCloseSeen &&
            ((message.exitCode !== undefined && message.exitCode !== pnpmCloseCode) ||
              (message.signal !== undefined && message.signal !== pnpmCloseSignal))
          ) {
            protocolFailure('terminal-contract-invalid');
            return;
          }
          result = projectResult(message);
          state = 'completing';
          schedule?.finish();
        }
        maybeComplete();
      } catch {
        protocolFailure('driver-message-processing-failed');
      }
    };

    onError = () => requestFallback('driver-process-error');
    onExit = (code, signal) => {
      driverExitSeen = true;
      driverExitCode = code;
      driverExitSignal = signal;
      maybeComplete();
    };
    onClose = (code, signal) => {
      driverCloseSeen = true;
      driverCloseCode = code;
      driverCloseSignal = signal;
      maybeComplete();
    };
    onDisconnect = () => {
      if (result === undefined) {
        requestFallback('driver-disconnected-before-result');
      }
    };

    try {
      child = fork(driverPath, [JSON.stringify(input)], {
        cwd: process.cwd(),
        env: environment,
        execPath: input.nodeExecutable,
        execArgv: [],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
    } catch {
      fallback = 'driver-spawn-failed';
      report(true);
      return;
    }
    child.stderr?.on('data', () => undefined);
    child.stderr?.resume();
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('close', onClose);
    child.once('disconnect', onDisconnect);
    startupTimer = setTimeout(
      () => protocolFailure('driver-ready-deadline'),
      limits.readyTimeoutMs,
    );
  });
}
