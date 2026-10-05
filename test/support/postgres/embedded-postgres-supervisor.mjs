import { access, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { EmbeddedPostgresBackupService } from '../../../dist/postgres/embedded-postgres-backup.service.js';
import { EmbeddedPostgresPreparationService } from '../../../dist/postgres/embedded-postgres-preparation.service.js';
import { EmbeddedPostgresResourceService } from '../../../dist/postgres/embedded-postgres-resource.service.js';
import { ManagedProcessService } from '../../../dist/processes/managed-process.service.js';
import { PublishedControlService } from '../../../dist/processes/published-control.service.js';

const [mode] = process.argv.slice(2);

const powerCut = () => {
  process.kill(-process.pid, 'SIGKILL');
  return new Promise(() => undefined);
};

const supervisorKilled = () => {
  process.kill(process.pid, 'SIGKILL');
  return new Promise(() => undefined);
};

const appears = async (path) => {
  try {
    await access(path);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return appears(path);
  }
};

class InterruptedInitialization extends ManagedProcessService {
  async start(request) {
    const pgdata = request.args.find((argument) => argument.startsWith('--pgdata='));
    if (!pgdata || mode === 'serve' || mode === 'inside-backup') {
      return super.start(request);
    }
    if (mode === 'before-initdb') {
      return powerCut();
    }
    const initdb = await super.start(request);
    if (mode === 'inside-initdb' || mode === 'supervisor-killed-inside-initdb') {
      await appears(join(pgdata.slice('--pgdata='.length), 'global', 'pg_control'));
      return mode === 'inside-initdb' ? powerCut() : supervisorKilled();
    }
    await initdb.completion;
    return powerCut();
  }
}

class InterruptedBackup extends EmbeddedPostgresBackupService {
  async copyCluster(clusterDir, destination) {
    await mkdir(destination, { mode: 0o700 });
    await cp(join(clusterDir, 'global'), join(destination, 'global'), { recursive: true });
    return powerCut();
  }
}

const processes = new InterruptedInitialization();
const held = await new PublishedControlService(
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  new EmbeddedPostgresResourceService(
    new EmbeddedPostgresPreparationService(processes),
    processes,
    undefined,
    undefined,
    mode === 'inside-backup' ? new InterruptedBackup() : undefined,
  ),
).open({
  dataDir: process.env.REVO_TEST_DATA,
  logDir: process.env.REVO_TEST_LOG,
  runtimeDir: process.env.REVO_TEST_RUNTIME,
  version: process.env.REVO_TEST_VERSION ?? '1.2.3',
  channel: 'stable',
  onStop: () => undefined,
  startupProgress: { operationId: 'feedfacefeedfacefeedfacefeedface', now: () => Date.now() },
});
const started = await held.startDatabase({
  signal: new AbortController().signal,
  timeoutMs: 60_000,
});
process.send({ port: started.port });
setInterval(() => undefined, 60_000);
