import type { CoreHostMessage } from '../core-host/core-child-protocol.js';

const pending: unknown[] = [];
let receive: ((message: unknown) => void) | undefined;
let disconnected: (() => void) | undefined;
let disconnectPending = false;

process.on('message', (message) => (receive ? receive(message) : pending.push(message)));
process.once('disconnect', () => {
  if (disconnected) {
    disconnected();
  } else {
    disconnectPending = true;
  }
});

const send = (message: CoreHostMessage) =>
  new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error('IPC unavailable'));
      return;
    }
    process.send(message, (error) => (error === null ? resolve() : reject(error)));
  });

void import('../core-host/core-child-runner.js')
  .then(({ CoreChildRunner }) => {
    const runner = new CoreChildRunner({
      send,
      finish: (exitCode) => {
        process.exitCode = exitCode;
        if (process.connected) {
          process.disconnect?.();
        }
      },
    });
    receive = (message) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'protocol' in message &&
        message.protocol === 'revo-core-host/v1' &&
        'type' in message &&
        message.type === 'hello'
      ) {
        void send({ protocol: 'revo-core-host/v1', type: 'booted' }).catch(() => {
          process.exitCode = 1;
          if (process.connected) {
            process.disconnect?.();
          }
        });
        return;
      }
      runner.receive(message);
    };
    disconnected = () => void runner.disconnected();
    if (disconnectPending) {
      disconnected();
    }
    pending.splice(0).forEach(receive);
  })
  .catch(() => {
    process.exitCode = 1;
    if (process.connected) {
      process.disconnect?.();
    }
  });
