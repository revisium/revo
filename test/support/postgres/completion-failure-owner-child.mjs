import {
  ControlClientService,
  ControlDiscoveryService,
  PublishedControlError,
  PublishedControlService,
} from '@revisium/revo/processes';

import { EmbeddedPostgresResourceService } from '../../../dist/postgres/embedded-postgres-resource.service.js';

const unhandled = [];
const onUnhandledRejection = (reason, promise) => unhandled.push({ reason, promise });
process.on('unhandledRejection', onUnhandledRejection);

let owner;
let processes;
let releaseObserved = false;
let queue = Promise.resolve();
let exiting = false;

function reply(id, value) {
  return new Promise((resolve, reject) => {
    process.send?.({ id, ...value }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function start() {
  const { CompletionFailurePostgresProcesses } = await import(process.env.REVO_TEST_ADAPTER);
  processes = new CompletionFailurePostgresProcesses();
  const postgres = new EmbeddedPostgresResourceService(undefined, processes);
  let now = 0;
  owner = await new PublishedControlService(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    postgres,
  ).open({
    dataDir: process.env.REVO_TEST_DATA,
    logDir: process.env.REVO_TEST_LOG,
    runtimeDir: process.env.REVO_TEST_RUNTIME,
    version: '1.2.3',
    channel: 'stable',
    onStop: () => undefined,
    startupProgress: {
      operationId: 'abcdefabcdefabcdefabcdefabcdefab',
      now: () => ++now,
    },
  });
  if (owner.kind !== 'held' || !owner.prepareEmbeddedPostgres || !owner.startDatabase) {
    throw new Error('Published control owner was not acquired');
  }
  void owner.ownershipReleased().then(() => {
    releaseObserved = true;
  });
  await owner.prepareEmbeddedPostgres({
    signal: new AbortController().signal,
    timeoutMs: 120_000,
  });
  await owner.startDatabase({ signal: new AbortController().signal, timeoutMs: 60_000 });
  return { kind: 'ready', owner: owner.kind };
}

async function command(name) {
  if (name === 'start') {
    return start();
  }
  if (!owner || owner.kind !== 'held' || !processes) {
    throw new Error('Owner harness has not started');
  }
  if (name === 'fail-completion') {
    await processes.stopPostgresForFixture();
    await processes.waitForInjectedCompletionFailure();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return {
      kind: 'completion-failed',
      physicalExitConfirmed: true,
      unhandled: unhandled.length,
    };
  }
  if (name === 'close-owner') {
    try {
      await owner.close();
      return { kind: 'closed' };
    } catch (error) {
      return {
        kind: 'close-rejected',
        name: error?.name,
        code: error?.code,
        phase: error instanceof PublishedControlError ? error.phase : undefined,
        ownership: error instanceof PublishedControlError ? error.ownership : undefined,
        cleanupFailures: error instanceof PublishedControlError ? error.cleanupFailures : undefined,
      };
    }
  }
  if (name === 'inspect') {
    const discovered = await new ControlDiscoveryService().read(process.env.REVO_TEST_DATA);
    const probe =
      discovered.kind === 'found'
        ? await new ControlClientService().probe(discovered.record)
        : undefined;
    return {
      kind: 'state',
      owner: owner.kind,
      releaseObserved,
      postgresStarts: processes.postgresStarts,
      postgresStops: processes.postgresStops,
      control: discovered.kind,
      probe: probe?.kind,
      unhandled: unhandled.length,
    };
  }
  if (name === 'shutdown-harness') {
    if (exiting) {
      return { kind: 'drained' };
    }
    exiting = true;
    await processes.drain();
    await reply(currentMessageId, { kind: 'drained' });
    process.off('unhandledRejection', onUnhandledRejection);
    process.exit(0);
  }
  throw new Error(`Unknown owner harness command: ${name}`);
}

let currentMessageId;
process.on('message', (message) => {
  if (!message || typeof message.id !== 'string' || typeof message.command !== 'string') {
    return;
  }
  currentMessageId = message.id;
  queue = queue.then(async () => {
    try {
      const result = await command(message.command);
      if (message.command !== 'shutdown-harness') {
        await reply(message.id, result);
      }
    } catch (error) {
      await reply(message.id, {
        kind: 'error',
        name: error?.name,
        message: error?.message,
      }).catch(() => undefined);
    }
  });
});
