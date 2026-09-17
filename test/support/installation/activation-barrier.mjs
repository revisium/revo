// oxlint-disable curly, no-await-in-loop -- bounded fixture gate observation
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
      const releaseGate = () => void unlink(gate).catch(() => undefined);
      if (mode === 'cancel' || mode === 'unknown') {
        process.once('SIGTERM', releaseGate);
      }
      try {
        await appendFile(marker, 'held\n');
      } catch (error) {
        await lease.release().catch(() => undefined);
        throw error;
      }
      if (mode === 'cancel' || mode === 'unknown') {
        const waitForGate = async () => {
          const events = watch(dirname(gate));
          try {
            while (
              await access(gate).then(
                () => true,
                () => false,
              )
            )
              await events.next();
          } finally {
            await events.return();
          }
        };
        try {
          await waitForGate();
        } catch (error) {
          await lease.release().catch(() => undefined);
          throw error;
        } finally {
          process.removeListener('SIGTERM', releaseGate);
        }
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
