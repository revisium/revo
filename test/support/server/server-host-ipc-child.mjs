import { stat, writeFile } from 'node:fs/promises';

import { ServerHostEntry } from '../../../dist/server/server-host-entry.js';
import { NodeServerHostProcessPort } from '../../../dist/server/server-host-process-port.js';

const root = process.env.REVO_SERVER_HOST_ROOT;
const deadline = Date.now() + 3_000;
const disconnectObserved = new Promise((resolve, reject) => {
  process.once('disconnect', () => {
    writeFile(`${root}/disconnect-observed`, 'disconnect-observed').then(resolve, reject);
  });
});
const disconnectRejectionObserved = disconnectObserved.then(undefined, () => undefined);
let resolveOutcome;
let resolveReleased;
const outcome = new Promise((resolve) => (resolveOutcome = resolve));
const released = new Promise((resolve) => (resolveReleased = resolve));
const owner = {
  start: () => Promise.reject(new Error('late owner must not start')),
  outcome: () => outcome,
  ownershipReleased: () => released,
  close: async () => {
    await writeFile(`${root}/close-entered`, 'close-entered');
    await waitFor(`${root}/release-close`, deadline);
    await writeFile(`${root}/closed`, 'closed');
    resolveReleased();
    resolveOutcome({ kind: 'stopped' });
  },
};

const entry = new ServerHostEntry(new NodeServerHostProcessPort(), {
  open: async () => {
    await writeFile(`${root}/open-entered`, 'open-entered');
    await waitFor(`${root}/allow-owner`, deadline);
    return owner;
  },
});

await entry.start();
await disconnectRejectionObserved;
await disconnectObserved;
await writeFile(`${root}/entry-completed`, 'entry-completed');

async function waitFor(path, gateDeadline) {
  if (
    await stat(path).then(
      () => true,
      () => false,
    )
  ) {
    return;
  }
  if (Date.now() >= gateDeadline) {
    throw new Error('Server host fixture gate deadline exceeded');
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  await waitFor(path, gateDeadline);
}
