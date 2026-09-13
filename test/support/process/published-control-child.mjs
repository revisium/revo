import { PublishedControlService } from '../../../dist/processes/published-control.service.js';

const held = await new PublishedControlService().open({
  dataDir: process.env.REVO_TEST_DATA,
  runtimeDir: process.env.REVO_TEST_RUNTIME,
  version: '1.2.3',
  channel: 'stable',
  onStop: () => undefined,
});
process.send?.({ kind: held.kind });
process.on('message', async (message) => {
  if (message === 'close' && held.kind === 'held') {
    await held.close();
  }
  process.exit(0);
});
