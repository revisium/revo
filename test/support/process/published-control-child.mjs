import { PublishedControlService } from '../../../dist/processes/published-control.service.js';

const held = await new PublishedControlService().open({
  dataDir: process.env.REVO_TEST_DATA,
  logDir: process.env.REVO_TEST_LOG,
  runtimeDir: process.env.REVO_TEST_RUNTIME,
  version: '1.2.3',
  channel: 'stable',
  onStop: () => undefined,
});
process.send?.({ kind: held.kind });
const closeAndExit = async (message) => {
  if (message === 'close' && held.kind === 'held') {
    await held.close();
  }
  process.exit(0);
};
process.on('message', (message) => {
  void closeAndExit(message).then(undefined, () => process.exit(1));
});
