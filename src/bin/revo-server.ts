import process from 'node:process';

import { ignoreOutputFailures } from '../server-logs/process-output.js';
import { RevoConsoleLogger } from '../server-logs/revo-console-logger.js';
import { NodeServerHostProcessPort } from '../server/server-host-process-port.js';
import { SERVER_HOST_PROTOCOL } from '../server/server-host-protocol.js';

ignoreOutputFailures();

const SEND_MILLISECONDS = 250;
const processPort = new NodeServerHostProcessPort();
const logger = new RevoConsoleLogger('RevoServer');

try {
  const [{ NestFactory }, { ServerHostEntry }, { ServerOwnerService }, { ServerModule }] =
    await Promise.all([
      import('@nestjs/core'),
      import('../server/server-host-entry.js'),
      import('../server/server-owner.service.js'),
      import('../server/server.module.js'),
    ]);
  const application = await NestFactory.createApplicationContext(ServerModule, { logger });
  const owners = application.get(ServerOwnerService);
  const entry = new ServerHostEntry(processPort, {
    open: async (request) => {
      const opened = await owners.open(request);
      return opened.kind === 'busy' ? 'busy' : opened;
    },
  });
  await entry.start();
  await application.close();
} catch (error) {
  logger.failure('Revo server failed to start', error);
  await processPort
    .send(
      { protocol: SERVER_HOST_PROTOCOL, type: 'failed', code: 'SERVER_HOST_FAILED' },
      Date.now() + SEND_MILLISECONDS,
    )
    .catch(() => undefined);
  await processPort.close(Date.now() + SEND_MILLISECONDS).catch(() => undefined);
  process.exitCode = 1;
}
