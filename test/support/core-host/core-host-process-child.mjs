import { appendFile, writeFile } from 'node:fs/promises';

const mode = process.env.REVO_CORE_HOST_FIXTURE_MODE;
const root = process.env.REVO_CORE_HOST_FIXTURE_ROOT;

const observe = (operation) => {
  void operation.catch(() => process.exit(2));
};

await appendFile(`${root}/spawns`, 'spawn\n');

if (mode === 'resistant') {
  process.on('SIGTERM', () => undefined);
}
if (mode === 'delayed-shutdown') {
  process.on('SIGTERM', () => {
    observe(writeFile(`${root}/term-received`, 'yes'));
  });
}

const handleMessage = async (message) => {
  if (message?.type === 'hello') {
    if (mode === 'exit-before-boot') {
      process.exit(7);
    }
    if (mode === 'delayed-boot') {
      await writeFile(`${root}/boot-blocked`, 'yes');
      return;
    }
    if (mode === 'early-listening') {
      process.send?.({
        protocol: 'revo-core-host/v1',
        type: 'listening',
        host: '127.0.0.1',
        port: 43210,
        url: 'http://127.0.0.1:43210',
      });
      return;
    }
    process.send?.({ protocol: 'revo-core-host/v1', type: 'booted' });
    return;
  }
  if (message?.type === 'start') {
    if (mode === 'exit-before-listening') {
      process.exit(8);
    }
    if (mode === 'failed-then-listening') {
      process.send?.({ protocol: 'revo-core-host/v1', type: 'failed', code: 'CORE_HOST_FAILED' });
    }
    process.send?.({
      protocol: 'revo-core-host/v1',
      type: 'stage',
      stage: 'application-database-migrations',
      status: 'started',
    });
    process.send?.({
      protocol: 'revo-core-host/v1',
      type: 'stage',
      stage: 'application-database-migrations',
      status: 'completed',
    });
    process.send?.({
      protocol: 'revo-core-host/v1',
      type: 'listening',
      host: '127.0.0.1',
      port: 43210,
      url: 'http://127.0.0.1:43210',
    });
    if (mode === 'late-stage-after-listening') {
      process.send?.({
        protocol: 'revo-core-host/v1',
        type: 'stage',
        stage: 'dbos-system-migrations',
        status: 'started',
      });
    }
    if (mode === 'duplicate-listening') {
      process.send?.({
        protocol: 'revo-core-host/v1',
        type: 'listening',
        host: '127.0.0.1',
        port: 43210,
        url: 'http://127.0.0.1:43210',
      });
    }
    if (mode === 'exit-after-listening') {
      setTimeout(() => process.exit(9), 20);
    }
    return;
  }
  if (message?.type === 'shutdown' && mode !== 'resistant') {
    if (mode === 'delayed-shutdown') {
      setTimeout(() => process.exit(0), 100);
    } else {
      process.exit(0);
    }
  }
};

process.on('message', (message) => {
  void handleMessage(message).catch(() => process.exit(2));
});
