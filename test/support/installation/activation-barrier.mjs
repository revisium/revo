import { access, appendFile, unlink, watch } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const query = new URL(import.meta.url).searchParams;
const mode = query.get('mode');
const root = query.get('root');
if (mode !== null && root !== null) {
  const owner = await import(
    resolve(dirname(process.argv[1]), '../processes/server-ownership.service.js')
  );
  const original = owner.ServerOwnershipService.prototype.acquire;
  owner.ServerOwnershipService.prototype.acquire = async function (dataDir) {
    const lease = await original.call(this, dataDir);
    if (lease.kind === 'held') {
      const marker = resolve(root, 'activation-barrier.held');
      const gate = resolve(root, 'activation-barrier.gate');
      await appendFile(marker, 'held\n');
      if (mode === 'cancel' || mode === 'unknown') {
        process.once('SIGTERM', () => void unlink(gate).catch(() => undefined));
        const waitForGate = async () => {
          const present = await access(gate).then(
            () => true,
            () => false,
          );
          if (!present) {
            return;
          }
          const events = watch(dirname(gate));
          try {
            await events.next();
          } finally {
            await events.return();
          }
          await waitForGate();
        };
        await waitForGate();
      }
    }
    return lease;
  };
  if (mode === 'unknown') {
    const output = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      if (typeof chunk === 'string' && chunk.includes('"status":"activated"')) {
        process.kill(process.pid, 'SIGKILL');
      }
      return output(chunk, ...rest);
    };
  }
}
