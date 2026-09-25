const own = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function send(message) {
  return new Promise((resolve) => {
    if (typeof process.send !== 'function' || !process.connected) {
      resolve(false);
      return;
    }
    process.send(message, (cause) => resolve(cause === null || cause === undefined));
  });
}

const baseEvent = (name, fields = {}) => ({ type: 'event', name, atMs: 1, ...fields });
const snapshot = (id, activity = []) => ({
  type: 'snapshot',
  id,
  atMs: 2,
  stdoutBytes: 0,
  stderrBytes: 0,
  logSafe: true,
  logState: 'safe',
  logSize: 0,
  tailChanged: false,
  activity,
  lastActivityMs: activity.length ? 1 : null,
  errorCodes: [],
  malformedLines: 0,
  droppedLines: 0,
});
const budgetActivity = [
  'pnpm:stage:stage-started',
  'pnpm:stage:stage-completed',
  'pnpm:stage:other',
  ...['pnpm:progress', 'pnpm:root', 'pnpm:execution-time', 'pnpm'].flatMap((name) =>
    [
      'started',
      'progress',
      'completed',
      'failed',
      'resolved',
      'fetched',
      'found_in_store',
      'imported',
      'activity',
      'other',
    ].map((status) => `${name}:${status}`),
  ),
]
  .slice(0, 32)
  .map((name, index) => ({ name, count: index + 1 }));

async function finishSuccess({ heartbeat = false } = {}) {
  await send(baseEvent('exit', { code: 0, signal: null }));
  await send(baseEvent('close', { code: 0, signal: null }));
  await send(snapshot(6, heartbeat ? [{ name: 'pnpm:progress:fetched', count: 1 }] : []));
  await send({
    type: 'result',
    outcome: 'success',
    atMs: 3,
    stdoutBytes: 0,
    stderrBytes: 0,
    observerIncomplete: false,
    exitCode: 0,
    signal: null,
  });
  process.disconnect();
}

async function main() {
  let input;
  try {
    input = JSON.parse(process.argv[2]);
  } catch {
    input = undefined;
  }
  if (!own(input) || process.execPath !== input.nodeExecutable) {
    await send({
      type: 'result',
      outcome: 'driver-error',
      atMs: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      observerIncomplete: true,
    });
    process.disconnect();
    return;
  }

  const scenario = process.env.REVO_DIAGNOSTIC_FIXTURE_SCENARIO;
  if (scenario === 'early-driver-error') {
    await send({
      type: 'result',
      outcome: 'driver-error',
      atMs: 1,
      stdoutBytes: 0,
      stderrBytes: 0,
      observerIncomplete: true,
    });
    process.disconnect();
    return;
  }
  if (scenario === 'disconnect') {
    await send(baseEvent('ready'));
    process.disconnect();
    return;
  }
  if (scenario === 'duplicate-result') {
    await send({
      type: 'result',
      outcome: 'driver-error',
      atMs: 1,
      stdoutBytes: 0,
      stderrBytes: 0,
      observerIncomplete: true,
    });
    await send({
      type: 'result',
      outcome: 'driver-error',
      atMs: 2,
      stdoutBytes: 0,
      stderrBytes: 0,
      observerIncomplete: true,
    });
    process.disconnect();
    return;
  }
  if (scenario === 'inherited-pipe') {
    const { spawn } = await import('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 120)'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    descendant.unref();
    await send({
      type: 'result',
      outcome: 'driver-error',
      atMs: 1,
      stdoutBytes: 0,
      stderrBytes: 0,
      observerIncomplete: true,
    });
    process.disconnect();
    return;
  }

  await send(baseEvent('ready'));
  await send(baseEvent('spawn'));

  if (scenario === 'contradictory') {
    await send(baseEvent('exit', { code: 0, signal: null }));
    await send(baseEvent('close', { code: 0, signal: null }));
    await send(snapshot(6));
    await send({
      type: 'result',
      outcome: 'install-error',
      atMs: 3,
      stdoutBytes: 0,
      stderrBytes: 0,
      observerIncomplete: false,
      exitCode: 1,
      signal: null,
    });
    process.disconnect();
    return;
  }

  if (scenario === 'budget-overflow') {
    for (let id = 0; id < 6; id += 1) {
      // oxlint-disable-next-line no-await-in-loop -- preserve snapshot ids and bounded IPC send order.
      await send(snapshot(id, budgetActivity));
    }
    process.disconnect();
    return;
  }

  if (scenario === 'heartbeat') {
    await send(snapshot(0, [{ name: 'pnpm:progress:fetched', count: 2 }]));
    await finishSuccess({ heartbeat: true });
    return;
  }

  if (scenario === 'abort-settle' || scenario === 'ignore-abort' || scenario === 'silent-hang') {
    process.on('message', (control) => {
      if (!own(control) || control.type !== 'abort' || scenario !== 'abort-settle') {
        return;
      }
      void (async () => {
        await send(baseEvent('abort-received'));
        await send(baseEvent('exit', { code: null, signal: 'SIGTERM' }));
        await send(baseEvent('close', { code: null, signal: 'SIGTERM' }));
        await send({
          type: 'result',
          outcome: 'install-error',
          atMs: 4,
          stdoutBytes: 0,
          stderrBytes: 0,
          observerIncomplete: false,
          exitCode: null,
          signal: 'SIGTERM',
        });
        process.disconnect();
      })();
    });
    return;
  }

  await finishSuccess();
}

main().catch(() => {
  process.exitCode = 1;
  if (process.connected) {
    process.disconnect();
  }
});
