import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RevoConfiguration } from '../../../src/configuration/configuration.types.js';
import { resolveRevoLayout } from '../../../src/layout.js';
import { openServerLog, serverLogPath } from '../../../src/server-logs/server-log.js';

/** A real private server log written through the production append path, one block per start. */
export class ServerLogFixture {
  private constructor(
    private readonly root: string,
    readonly configuration: Readonly<RevoConfiguration>,
  ) {}

  static async create(): Promise<ServerLogFixture> {
    const root = await mkdtemp(join(tmpdir(), 'revo-server-log-'));
    const layout = resolveRevoLayout({
      channel: 'alpha',
      env: {},
      homeDir: join(root, 'home'),
      platform: 'linux',
    });
    return new ServerLogFixture(
      root,
      Object.freeze({
        channel: 'alpha',
        configPath: join(root, 'config.json'),
        host: '127.0.0.1',
        installDir: join(root, 'install'),
        layout: Object.freeze(layout),
        logDir: join(root, 'logs'),
        port: 3210,
        publicUrl: 'http://127.0.0.1:3210',
        startupTimeout: 180_000,
      }),
    );
  }

  path(): Promise<string> {
    return serverLogPath(this.location());
  }

  async startAttempt(lines: readonly string[]): Promise<void> {
    const log = await openServerLog(this.location());
    try {
      await log.handle.write(lines.map((line) => `${line}\n`).join(''));
    } finally {
      await log.handle.close();
    }
  }

  dispose(): Promise<void> {
    return rm(this.root, { recursive: true, force: true });
  }

  private location() {
    return {
      logDir: this.configuration.logDir,
      channel: this.configuration.channel,
      dataDir: this.configuration.layout.dataDir,
    };
  }
}
