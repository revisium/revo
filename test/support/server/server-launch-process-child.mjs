import { appendFile } from 'node:fs/promises';

const PROTOCOL = 'revo-server-host/v1';
const eventsPath = process.env.REVO_LAUNCH_PROCESS_EVENTS;

if (!eventsPath || typeof process.send !== 'function') {
  process.exitCode = 2;
} else {
  process.send({ protocol: PROTOCOL, type: 'booted' });
  process.on('message', (message) => {
    void handleMessage(message);
  });
}

async function handleMessage(message) {
  await appendFile(eventsPath, `${JSON.stringify(message)}\n`);
  if (!message || message.protocol !== PROTOCOL) {
    return;
  }
  if (message.type === 'commit') {
    process.send({ protocol: PROTOCOL, type: 'committed', operationId: message.operationId });
  } else if (message.type === 'cancel') {
    process.disconnect();
  }
}
