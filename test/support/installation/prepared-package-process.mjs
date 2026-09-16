import { publishPreparedPackage } from '../../../dist/installation/prepared-package.js';

process.send?.({ ready: true });
process.on('message', (input) => {
  void (async () => {
    try {
      const result = await publishPreparedPackage(input);
      process.send?.({ ok: true, directory: result.directory });
    } catch {
      process.send?.({ ok: false });
    } finally {
      process.disconnect?.();
    }
  })();
});
