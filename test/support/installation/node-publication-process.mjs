import { publishNodeBootstrap } from '../../../installer/node-bootstrap.mjs';

if (process.env.REVO_TEST_PUBLISHER_MODE === 'exit-before-ready') {
  process.exit(17);
}
if (process.env.REVO_TEST_PUBLISHER_MODE === 'hang-before-ready') {
  setInterval(() => {}, 1000);
}

process.send?.({ ready: true });
process.on('message', (input) => {
  void (async () => {
    try {
      const result = await publishNodeBootstrap(input);
      process.send?.({ ok: true, result });
    } catch {
      process.send?.({ ok: false });
    } finally {
      process.disconnect();
    }
  })();
});
