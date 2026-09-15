import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { parseLifecycleDocument } from '../../../src/server-logs/document.js';
import {
  SERVER_LIFECYCLE_TEMP_FILE,
  type ServerLifecycleConfiguration,
  type ServerLifecycleEvent,
} from '../../../src/server-logs/server-lifecycle.types.js';
import {
  serverLifecyclePath,
  ServerLifecycleStore,
} from '../../../src/server-logs/store.service.js';

const run = promisify(execFile);
type FileName = 'target' | 'temp';
type Options = Partial<
  Pick<ServerLifecycleConfiguration, 'channel' | 'canonicalDataDir' | 'logDir'>
>;

export class ServerLifecycleScenario {
  private constructor(
    readonly root: string,
    readonly dataDir: string,
    readonly otherDataDir: string,
    readonly logDir: string,
  ) {}

  static async create(): Promise<ServerLifecycleScenario> {
    const root = await fs.mkdtemp(join(tmpdir(), 'revo-lifecycle-'));
    const dataDir = join(root, 'data');
    const otherDataDir = join(root, 'other-data');
    const logDir = join(root, 'logs');
    await Promise.all([
      fs.mkdir(dataDir, { mode: 0o700 }),
      fs.mkdir(otherDataDir, { mode: 0o700 }),
    ]);
    return new ServerLifecycleScenario(root, dataDir, otherDataDir, logDir);
  }

  configuration(options: Options = {}): ServerLifecycleConfiguration {
    return {
      logDir: options.logDir ?? this.logDir,
      canonicalDataDir: options.canonicalDataDir ?? this.dataDir,
      channel: options.channel ?? 'stable',
      now: () => 1_700_000_000_000,
    };
  }

  path(options: Options = {}): string {
    return serverLifecyclePath(this.configuration(options));
  }

  async open(options: Options = {}) {
    return ServerLifecycleStore.open(this.configuration(options));
  }

  async document(options: Options = {}) {
    return parseLifecycleDocument(await fs.readFile(this.path(options), 'utf8'));
  }

  async seed(name: FileName, content: string, options: Options = {}): Promise<string> {
    const path = this.file(name, options);
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(path, content, { mode: 0o600 });
    return path;
  }

  async unsafe(
    name: FileName,
    kind: 'symlink' | 'fifo' | 'hardlink',
    options: Options = {},
  ): Promise<string> {
    const path = this.file(name, options);
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.rm(path, { force: true });
    await (kind === 'symlink'
      ? fs.symlink(join(this.root, 'outside'), path)
      : kind === 'fifo'
        ? run('mkfifo', [path])
        : fs
            .writeFile(join(this.root, 'hardlink-source'), 'outside', { mode: 0o600 })
            .then(() => fs.link(join(this.root, 'hardlink-source'), path)));
    return path;
  }

  async mode(name: FileName, permissions: number, options = {}) {
    await fs.chmod(this.file(name, options), permissions);
  }

  async replaceParentWithFile(): Promise<ServerLifecycleConfiguration> {
    const parent = join(this.root, 'unsafe-parent');
    await fs.writeFile(parent, 'not a directory', { mode: 0o600 });
    return this.configuration({ logDir: join(parent, 'logs') });
  }

  async raw(name: FileName, options: Options = {}): Promise<string> {
    return fs.readFile(this.file(name, options), 'utf8');
  }

  async dispose(): Promise<void> {
    await fs.rm(this.root, { force: true, recursive: true });
  }

  private file(name: FileName, options: Options) {
    return name === 'target'
      ? this.path(options)
      : join(dirname(this.path(options)), SERVER_LIFECYCLE_TEMP_FILE);
  }
}

export const event = (sequence: number, code: string, phase = 'server', state = 'starting') =>
  ({ sequence, time: 1_700_000_000_000, phase, state, code }) as unknown as ServerLifecycleEvent; // oxlint-disable-line typescript/no-unsafe-type-assertion
