import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';

import { BUILT_CLI, CliScenario, isolatedEnvironment, type CliResult } from './cli-scenario.js';

export type CliExit = Pick<CliResult, 'exitCode' | 'signal'>;

const START_MILLISECONDS = 120_000;

/** Drives the built CLI against one real server in a private home. */
export class IsolatedServerScenario {
  private constructor(
    private readonly home: string,
    private readonly port: string,
  ) {}

  static async create(): Promise<IsolatedServerScenario> {
    // A canonical home keeps private server logs usable where tmpdir is behind a symlink.
    const home = await mkdtemp(`${await realpath(tmpdir())}/revo-home-`);
    return new IsolatedServerScenario(home, String(await freeLoopbackPort()));
  }

  /** Starts for a reader that has already closed stdout and stderr; JSONL progress is optional. */
  startWithClosedOutput(output: 'jsonl' | 'plain' = 'jsonl'): Promise<CliExit> {
    const progress = output === 'jsonl' ? ['--progress=jsonl'] : [];
    const child = spawn(
      process.execPath,
      [BUILT_CLI, 'server', 'start', ...progress, '--port', this.port],
      {
        cwd: this.home,
        env: isolatedEnvironment(this.home),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: START_MILLISECONDS,
      },
    );
    child.stdout.destroy();
    child.stderr.destroy();
    return new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', (exitCode, signal) => resolveExit({ exitCode, signal }));
    });
  }

  status(): Promise<CliResult> {
    return CliScenario.run(['server', 'status'], isolatedEnvironment(this.home));
  }

  async dispose(): Promise<void> {
    try {
      await CliScenario.run(['server', 'stop'], isolatedEnvironment(this.home));
    } finally {
      await rm(this.home, { recursive: true, force: true });
    }
  }
}

function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePort, rejectPort) => {
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address) {
          resolvePort(address.port);
        } else {
          rejectPort(new Error('No loopback port was reserved.'));
        }
      });
    });
  });
}
