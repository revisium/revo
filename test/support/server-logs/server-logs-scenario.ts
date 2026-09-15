import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServerLifecycleReader } from '../../../src/server-logs/reader.service.js';
import {
  SERVER_LIFECYCLE_RETAIN,
  type ServerLifecycleConfiguration,
} from '../../../src/server-logs/server-lifecycle.types.js';
import {
  serverLifecyclePath,
  ServerLifecycleStore,
} from '../../../src/server-logs/store.service.js';

export class ServerLogsScenario {
  private constructor(
    private readonly root: string,
    private readonly dataDir: string,
    private readonly logDir: string,
    private readonly canonicalDataDir: string,
  ) {}

  static async open(): Promise<ServerLogsScenario> {
    const root = await mkdtemp(join(tmpdir(), 'revo-logs-'));
    const dataDir = join(root, 'data');
    const logDir = join(root, 'logs');
    await mkdir(dataDir, { mode: 0o700 });
    return new ServerLogsScenario(root, dataDir, logDir, dataDir);
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  async read(afterSequence = 0) {
    return (await this.reader()).read(afterSequence);
  }

  async append(count: number): Promise<void> {
    const store = await ServerLifecycleStore.open(this.configuration());
    try {
      for (let index = 0; index < count; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- append preserves journal order
        await store.emit('SERVER_STARTING');
      }
    } finally {
      await store.close();
    }
  }

  async appendReady(): Promise<void> {
    const store = await ServerLifecycleStore.open(this.configuration());
    try {
      await store.emit('SERVER_READY');
    } finally {
      await store.close();
    }
  }

  async installMalformedDocument(): Promise<void> {
    await mkdir(join(this.targetDirectory()), { recursive: true, mode: 0o700 });
    await writeFile(this.targetPath(), '{"events": [}', { mode: 0o600 });
  }

  async installOversizedDocument(): Promise<void> {
    await mkdir(join(this.targetDirectory()), { recursive: true, mode: 0o700 });
    await writeFile(this.targetPath(), 'x'.repeat(65_537), { mode: 0o600 });
  }

  async installTargetSymlink(): Promise<void> {
    await mkdir(join(this.targetDirectory()), { recursive: true, mode: 0o700 });
    const alternate = join(this.root, 'alternate.json');
    await writeFile(alternate, '{}', { mode: 0o600 });
    await symlink(alternate, this.targetPath());
  }

  async installTemporaryDocument(): Promise<string> {
    const directory = this.targetDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, '.server-lifecycle.tmp');
    await writeFile(temporary, 'temporary', { mode: 0o600 });
    return temporary;
  }

  async installInsecureDocument(): Promise<void> {
    await mkdir(join(this.targetDirectory()), { recursive: true, mode: 0o700 });
    await writeFile(this.targetPath(), '{}', { mode: 0o644 });
  }

  configuration(): ServerLifecycleConfiguration {
    return { channel: 'stable', canonicalDataDir: this.canonicalDataDir, logDir: this.logDir };
  }

  private async reader(): Promise<ServerLifecycleReader> {
    return ServerLifecycleReader.open(this.configuration());
  }

  private targetDirectory(): string {
    return join(this.logDir, 'stable', this.digest());
  }

  private targetPath(): string {
    return serverLifecyclePath(this.configuration());
  }

  private digest(): string {
    return this.targetPath().split('/').at(-2) ?? '';
  }
}

export const retainedEvents = SERVER_LIFECYCLE_RETAIN;
