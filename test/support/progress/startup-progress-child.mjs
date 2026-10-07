import { PublishedControlService } from '../../../dist/processes/published-control.service.js';

let now = 0;
const held = await new PublishedControlService().open({
  dataDir: process.env.REVO_TEST_DATA,
  logDir: process.env.REVO_TEST_LOG,
  runtimeDir: process.env.REVO_TEST_RUNTIME,
  version: '1.2.3',
  channel: 'stable',
  onStop: () => undefined,
  startupProgress: {
    operationId: process.env.REVO_TEST_OPERATION,
    now: () => ++now,
  },
});
if (held.kind === 'held' && held.progress) {
  await held.progress.start('postgres-binary-prepare');
  await held.progress.progress('postgres-binary-prepare', { stageElapsedMs: 1 });
  await held.progress.progress('postgres-binary-prepare', { stageElapsedMs: 2 });
  await held.progress.complete('postgres-binary-prepare');
  await held.progress.start('postgres-initialization');
  await held.progress.progress('postgres-initialization', { stageElapsedMs: 1 });
}
process.send?.({ kind: held.kind });
const closeAndExit = async () => {
  if (held.kind === 'held') {
    await held.close();
  }
  process.exit(0);
};
process.on('message', () => {
  void closeAndExit().then(undefined, () => process.exit(1));
});
