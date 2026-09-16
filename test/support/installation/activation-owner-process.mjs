import { acquireActivationOwnership } from '../../../dist/installation/activation-ownership.js';

let lease;

process.on('message', (message) => {
  void handle(message);
});

async function handle(message) {
  if (message.action === 'acquire') {
    const result = await acquireActivationOwnership({
      channelRoot: message.root,
      channel: message.channel,
    });
    if (result.status === 'held') {
      lease = result.lease;
    }
    process.send?.({ status: result.status });
  }
  if (message.action === 'release' && lease !== undefined) {
    await lease.release();
    process.send?.({ status: 'released' });
  }
}
