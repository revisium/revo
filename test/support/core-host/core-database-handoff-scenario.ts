import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildCoreChildEnvironment } from '../../../src/core-host/core-child-environment.js';
import {
  CORE_HOST_PROTOCOL,
  type CoreHostStageMessage,
} from '../../../src/core-host/core-child-protocol.js';
import {
  CoreHostProcessService,
  type CoreHostProcessResource,
} from '../../../src/core-host/core-host-process.service.js';

const STOP_DEADLINE_MILLISECONDS = 3_000;

export class CoreDatabaseHandoffScenario {
  private readonly roots: string[] = [];
  private readonly resources: TrackedCoreResource[] = [];
  private readonly coreHosts = new CoreHostProcessService();
  private failureMessages: readonly CoreHostStageMessage[] = [];

  async isolatedHome(pgpass?: string) {
    const root = await this.root();
    const home = join(root, 'home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    if (pgpass !== undefined) {
      await writeFile(join(home, '.pgpass'), pgpass, { mode: 0o600 });
    }
    return home;
  }

  safeEnvironment(home: string, additions: NodeJS.ProcessEnv = {}) {
    const source = {
      HOME: home,
      USER: 'node',
      LOGNAME: 'node',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      SHELL: '/bin/sh',
      ...additions,
    };
    return buildCoreChildEnvironment(source).env;
  }

  async start(databaseUrl: string, env: Readonly<Record<string, string>>) {
    this.failureMessages = [];
    const root = await this.root();
    await Promise.all([
      mkdir(join(root, 'work'), { recursive: true }),
      mkdir(join(root, 'sessions'), { recursive: true }),
    ]);
    const resource = this.coreHosts.open({
      executable: process.execPath,
      entry: join(process.cwd(), 'dist/bin/revo-core-host.js'),
      cwd: process.cwd(),
      env,
    });
    const tracked: TrackedCoreResource = { resource, settled: false };
    this.resources.push(tracked);
    const messages: CoreHostStageMessage[] = [];
    const close = () => this.close(tracked);
    const startResult = await Promise.allSettled([
      resource.start(
        {
          protocol: CORE_HOST_PROTOCOL,
          type: 'start',
          databaseUrl,
          temporaryWorkingDirectoryRoot: join(root, 'work'),
          agentWorkspaceDirectory: join(root, 'sessions'),
          host: '127.0.0.1',
          port: 0,
        },
        {
          signal: new AbortController().signal,
          deadline: Date.now() + 30_000,
          onStage: async (message) => {
            messages.push(message);
          },
        },
      ),
    ]);
    const startOutcome = startResult[0];
    if (startOutcome?.status === 'fulfilled') {
      return { terminal: startOutcome.value, messages, close };
    }
    const primary = startOutcome?.reason;
    this.failureMessages = [...messages];
    const cleanupResult = await Promise.allSettled([close()]);
    const cleanupOutcome = cleanupResult[0];
    if (cleanupOutcome?.status === 'rejected') {
      throw new AggregateError(
        [primary, cleanupOutcome.reason],
        'Core database handoff start cleanup failed',
        { cause: primary },
      );
    }
    throw primary;
  }

  async startFailure(databaseUrl: string, env: Readonly<Record<string, string>>) {
    try {
      await this.start(databaseUrl, env);
    } catch (error) {
      return { error, messages: this.failureMessages };
    }
    throw new Error('Core database handoff unexpectedly started');
  }

  async cleanup() {
    const results = await Promise.allSettled(this.resources.map((tracked) => this.close(tracked)));
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (!this.hasNoRunningChildren()) {
      failures.push(new Error('Core database fixture child settlement was not confirmed'));
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Core database fixture cleanup failed');
    }
    await Promise.all(this.roots.map((root) => rm(root, { recursive: true, force: true })));
    this.resources.length = 0;
    this.roots.length = 0;
  }

  hasNoRunningChildren() {
    return this.resources.every((tracked) => tracked.settled);
  }

  private close(tracked: TrackedCoreResource): Promise<void> {
    if (!tracked.closeOperation) {
      let operation: Promise<void>;
      operation = this.performClose(tracked).catch((error: unknown) => {
        if (tracked.closeOperation === operation) {
          delete tracked.closeOperation;
        }
        throw error;
      });
      tracked.closeOperation = operation;
    }
    return tracked.closeOperation;
  }

  private async performClose(tracked: TrackedCoreResource) {
    const deadline = Date.now() + STOP_DEADLINE_MILLISECONDS;
    await tracked.resource.close(deadline);
    await withinDeadline(tracked.resource.settled(), deadline);
    tracked.settled = true;
  }

  private async root() {
    const root = await mkdtemp('/tmp/revo-core-handoff-');
    this.roots.push(root);
    return root;
  }
}

interface TrackedCoreResource {
  readonly resource: CoreHostProcessResource;
  closeOperation?: Promise<void>;
  settled: boolean;
}

function withinDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const milliseconds = Math.max(1, deadline - Date.now());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Core database fixture cleanup deadline expired')),
      milliseconds,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
