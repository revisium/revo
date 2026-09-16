import { publishNodeBootstrap } from '../../../installer/node-bootstrap.mjs';

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
