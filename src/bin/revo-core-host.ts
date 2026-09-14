import { CoreChildEntry, type CoreChildProcessPort } from '../core-host/core-child-entry.js';

const processPort: CoreChildProcessPort = {
  connected: () => process.connected,
  disconnect: () => process.disconnect?.(),
  onDisconnect: (listener) => process.once('disconnect', listener),
  onMessage: (listener) => process.on('message', listener),
  send: (message) =>
    new Promise<void>((resolve, reject) => {
      if (!process.connected || !process.send) {
        reject(new Error('IPC unavailable'));
        return;
      }
      process.send(message, (error) => (error === null ? resolve() : reject(error)));
    }),
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
};

new CoreChildEntry(processPort, async () => {
  const { CoreChildRunner } = await import('../core-host/core-child-runner.js');
  return CoreChildRunner;
}).start();
