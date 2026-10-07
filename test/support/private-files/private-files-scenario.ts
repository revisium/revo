import { link, mkdir, mkdtemp, open, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isSingleLinkedPrivateFile,
  READ_NOFOLLOW_FLAGS,
  readBoundedUtf8,
  readPrivateDataFile,
} from '../../../src/private-files.js';

const NAME = 'state.json';
const LIMIT = 8;

export class PrivateFilesScenario {
  private readonly roots: string[] = [];

  async dataDirectory(mode = 0o700): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'revo-private-files-'));
    this.roots.push(root);
    await chmod(root, mode);
    return root;
  }

  async withFile(content: string, mode = 0o600): Promise<string> {
    const dataDir = await this.dataDirectory();
    await writeFile(join(dataDir, NAME), content, { mode });
    await chmod(join(dataDir, NAME), mode);
    return dataDir;
  }

  read(dataDir: string) {
    return readPrivateDataFile(dataDir, NAME, LIMIT);
  }

  async readsFileOf(size: number): Promise<string | undefined> {
    const dataDir = await this.withFile('x'.repeat(size));
    const file = await open(join(dataDir, NAME), READ_NOFOLLOW_FLAGS);
    try {
      return await readBoundedUtf8(file, LIMIT);
    } finally {
      await file.close();
    }
  }

  async symlinkedFile() {
    const dataDir = await this.dataDirectory();
    const target = join(dataDir, 'target.json');
    await writeFile(target, 'ok', { mode: 0o600 });
    await symlink(target, join(dataDir, NAME));
    return dataDir;
  }

  async directoryInPlaceOfFile() {
    const dataDir = await this.dataDirectory();
    await mkdir(join(dataDir, NAME), { mode: 0o700 });
    return dataDir;
  }

  async identityOf(options: { readonly hardLink: boolean; readonly mode: number }) {
    const dataDir = await this.withFile('ok', options.mode);
    const path = join(dataDir, NAME);
    if (options.hardLink) {
      await link(path, join(dataDir, 'second-name.json'));
    }
    const file = await open(path, READ_NOFOLLOW_FLAGS);
    try {
      return isSingleLinkedPrivateFile(await file.stat(), await lstat(path));
    } finally {
      await file.close();
    }
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  }
}
