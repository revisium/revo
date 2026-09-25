import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { link as createHardLink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSourceSnapshot,
  collectSourceFiles,
  REQUIRED_SOURCE_FILES,
} from '../scripts/acceptance/source-snapshot.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('acceptance source snapshot', () => {
  it('copies only explicit build inputs and records their exact private bytes', async () => {
    const root = await fixture();
    const output = join(dirname(root), 'snapshot');
    const source = join(root, 'src', 'release-policy.ts');
    const sourceBytes = Buffer.from('export const candidate = true;\n');
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, sourceBytes);
    await writeFile(join(root, '.env.sonar'), 'SNAPSHOT_SECRET_SENTINEL\n');
    await mkdir(join(root, '.test-runtime'), { recursive: true });
    await writeFile(join(root, '.test-runtime', 'acceptance.log'), 'LOCAL_EVIDENCE_SENTINEL\n');
    await mkdir(join(root, 'tui-source'), { recursive: true });
    await writeFile(join(root, 'tui-source', 'package.json'), '{"private":true}\n');

    const result = await createSourceSnapshot({
      root,
      output,
      files: [...REQUIRED_SOURCE_FILES, 'src/release-policy.ts'],
    });

    await expect(readFile(join(output, 'src', 'release-policy.ts'))).resolves.toEqual(sourceBytes);
    await expect(lstat(join(output, '.env.sonar'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(output, '.test-runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(output, 'tui-source'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.files).toContainEqual({
      path: 'src/release-policy.ts',
      sha256: createHash('sha256').update(sourceBytes).digest('hex'),
    });
    const expectedFiles = await Promise.all(
      [...REQUIRED_SOURCE_FILES, 'src/release-policy.ts'].sort().map(async (path) => ({
        path,
        sha256: createHash('sha256')
          .update(await readFile(join(root, ...path.split('/'))))
          .digest('hex'),
      })),
    );
    expect(result.files).toEqual(expectedFiles);
    expect(result.files.map(({ path }) => path)).toEqual(
      [...result.files.map(({ path }) => path)].sort(),
    );
    expect((await lstat(output)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(output, 'src'))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(output, 'src', 'release-policy.ts'))).mode & 0o077).toBe(0);
    expect((await lstat(join(output, 'src', 'release-policy.ts'))).mode & 0o777).toBe(0o600);
  });

  it('rejects paths outside the build-input policy before copying', async () => {
    const root = await fixture();
    const output = join(dirname(root), 'snapshot');

    await expect(
      createSourceSnapshot({ root, output, files: [...REQUIRED_SOURCE_FILES, '../outside.txt'] }),
    ).rejects.toThrow(/inventory|path|source/u);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses current tracked bytes and requires explicit inventory for new task sources', async () => {
    const root = await fixture();
    const output = join(dirname(root), 'tracked-snapshot');
    await writeFile(join(root, 'package.json'), '{"version":"base"}\n');
    runGit(root, ['init', '-q']);
    runGit(root, ['config', 'user.name', 'Acceptance fixture']);
    runGit(root, ['config', 'user.email', 'acceptance@example.invalid']);
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-qm', 'source baseline']);

    await writeFile(join(root, 'package.json'), '{"version":"dirty"}\n');
    await writeFile(join(root, '.env.sonar'), 'TRACKED_INVENTORY_SECRET\n');
    await mkdir(join(root, 'tui-source'), { recursive: true });
    await writeFile(join(root, 'tui-source', 'package.json'), '{"name":"nested checkout"}\n');

    const tracked = await collectSourceFiles({ root });
    expect(tracked).not.toContain('src/new-task-source.ts');
    const copied = await createSourceSnapshot({ root, output, files: tracked });
    expect(await readFile(join(output, 'package.json'), 'utf8')).toBe('{"version":"dirty"}\n');
    expect(copied.files.some(({ path }) => path.includes('tui-source'))).toBe(false);
    expect(copied.files.some(({ path }) => path.startsWith('.env'))).toBe(false);

    const newSource = join(root, 'src', 'new-task-source.ts');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(newSource, 'export const task = true;\n');
    await expect(collectSourceFiles({ root })).rejects.toThrow(/production source file/u);
    const explicit = await collectSourceFiles({
      root,
      inventory: [...tracked, 'src/new-task-source.ts'],
    });
    expect(explicit).toContain('src/new-task-source.ts');
    await createSourceSnapshot({
      root,
      output: join(dirname(root), 'explicit-snapshot'),
      files: explicit,
    });
    expect(
      await readFile(join(dirname(root), 'explicit-snapshot', 'src', 'new-task-source.ts'), 'utf8'),
    ).toBe('export const task = true;\n');
  });

  it('requires explicit inventory for ignored production sources too', async () => {
    const root = await fixture();
    await writeFile(join(root, '.gitignore'), 'src/ignored-source.ts\n');
    runGit(root, ['init', '-q']);
    runGit(root, ['config', 'user.name', 'Acceptance fixture']);
    runGit(root, ['config', 'user.email', 'acceptance@example.invalid']);
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-qm', 'source baseline']);
    await writeFile(join(root, 'src', 'ignored-source.ts'), 'export {}\n');

    await expect(collectSourceFiles({ root })).rejects.toThrow(/production source file/u);
    await expect(
      collectSourceFiles({
        root,
        inventory: [...REQUIRED_SOURCE_FILES, 'src/ignored-source.ts'],
      }),
    ).resolves.toContain('src/ignored-source.ts');
  });

  it('rejects symlinks and does not copy their external target', async () => {
    const root = await fixture();
    const outside = join(dirname(root), 'outside.ts');
    const link = join(root, 'src', 'linked.ts');
    const output = join(dirname(root), 'snapshot');
    await writeFile(outside, 'OUTSIDE_SENTINEL\n');
    await mkdir(dirname(link), { recursive: true });
    await symlink(outside, link);

    await expect(
      createSourceSnapshot({ root, output, files: [...REQUIRED_SOURCE_FILES, 'src/linked.ts'] }),
    ).rejects.toThrow(/link|regular|source/u);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects hard-linked source files', async () => {
    const root = await fixture();
    const outside = join(dirname(root), 'hardlink-target.ts');
    const source = join(root, 'src', 'hardlinked.ts');
    const output = join(dirname(root), 'hardlink-snapshot');
    await mkdir(dirname(source), { recursive: true });
    await writeFile(outside, 'HARDLINK_SENTINEL\n');
    await createHardLink(outside, source);

    await expect(
      createSourceSnapshot({
        root,
        output,
        files: [...REQUIRED_SOURCE_FILES, 'src/hardlinked.ts'],
      }),
    ).rejects.toThrow(/hard link/u);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects output paths that resolve inside the source through a symlink parent', async () => {
    const root = await fixture();
    const redirect = join(dirname(root), 'source-redirect');
    await symlink(root, redirect, 'dir');

    await expect(
      createSourceSnapshot({
        root,
        output: join(redirect, 'snapshot'),
        files: REQUIRED_SOURCE_FILES,
      }),
    ).rejects.toThrow(/output must be outside/u);
  });

  it('fails closed when Git and an explicit inventory are both unavailable', async () => {
    const root = await fixture();
    const output = join(dirname(root), 'no-git-snapshot');

    await expect(createSourceSnapshot({ root, output })).rejects.toThrow(/Git inventory/u);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an output directory inside the source tree', async () => {
    const root = await fixture();
    const output = join(root, 'staging');

    await expect(
      createSourceSnapshot({ root, output, files: REQUIRED_SOURCE_FILES }),
    ).rejects.toThrow(/output|source/u);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['empty', ''],
    ['absolute', '/outside.ts'],
    ['backslash', 'src\\unsafe.ts'],
    ['NUL', 'src/unsafe\0.ts'],
    ['traversal', '../outside.ts'],
    ['forbidden local evidence', '.test-runtime/evidence.log'],
  ])('rejects %s inventory entries', async (_description, invalidPath) => {
    const root = await fixture();
    const output = join(dirname(root), 'invalid-inventory-snapshot');

    await expect(
      collectSourceFiles({ root, inventory: [...REQUIRED_SOURCE_FILES, invalidPath] }),
    ).rejects.toThrow(/inventory|path/u);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects duplicate and missing required inventory entries', async () => {
    const root = await fixture();
    const duplicate = REQUIRED_SOURCE_FILES[0];
    if (duplicate === undefined) {
      throw new Error('test required inventory is empty');
    }

    await expect(
      collectSourceFiles({ root, inventory: [...REQUIRED_SOURCE_FILES, duplicate] }),
    ).rejects.toThrow(/duplicate/u);
    await expect(
      collectSourceFiles({
        root,
        inventory: REQUIRED_SOURCE_FILES.filter((path) => path !== 'README.md'),
      }),
    ).rejects.toThrow(/missing a required/u);
  });

  it('rejects a tracked build input missing from disk', async () => {
    const root = await fixture();
    const output = join(dirname(root), 'missing-source-snapshot');
    await rm(join(root, 'README.md'));

    await expect(
      createSourceSnapshot({ root, output, files: REQUIRED_SOURCE_FILES }),
    ).rejects.toThrow(/ENOENT|README/u);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects source-parent replacement by a symlink after the initial identity check', async () => {
    const root = await fixture();
    const relativeFile = 'src/swap-parent/linked.ts';
    const sourceParent = join(root, 'src', 'swap-parent');
    const sourceFile = join(sourceParent, 'linked.ts');
    const movedParent = join(root, 'src', 'original-parent');
    const outsideParent = join(dirname(root), 'outside-parent');
    const outsideFile = join(outsideParent, 'linked.ts');
    const output = join(dirname(root), 'parent-symlink-snapshot');
    await mkdir(sourceParent, { recursive: true });
    await mkdir(outsideParent, { recursive: true });
    await writeFile(sourceFile, 'original source\n');
    await writeFile(outsideFile, 'OUTSIDE_SENTINEL\n');

    await expect(
      createSourceSnapshot({
        root,
        output,
        files: [...REQUIRED_SOURCE_FILES, relativeFile],
        testHooks: {
          beforeSourceOpen: async (path) => {
            if (path !== relativeFile) {
              return;
            }
            await rename(sourceParent, movedParent);
            await symlink(outsideParent, sourceParent, 'dir');
          },
        },
      }),
    ).rejects.toThrow(/changed|identity|source path/u);

    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('OUTSIDE_SENTINEL\n');
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects source-parent replacement by another directory with the same leaf name', async () => {
    const root = await fixture();
    const relativeFile = 'src/swap-directory/leaf.ts';
    const sourceParent = join(root, 'src', 'swap-directory');
    const movedParent = join(root, 'src', 'old-directory');
    const output = join(dirname(root), 'parent-directory-snapshot');
    await mkdir(sourceParent, { recursive: true });
    await writeFile(join(sourceParent, 'leaf.ts'), 'before swap\n');

    await expect(
      createSourceSnapshot({
        root,
        output,
        files: [...REQUIRED_SOURCE_FILES, relativeFile],
        testHooks: {
          beforeSourceOpen: async (path) => {
            if (path !== relativeFile) {
              return;
            }
            await rename(sourceParent, movedParent);
            await mkdir(sourceParent);
            await writeFile(join(sourceParent, 'leaf.ts'), 'before swap\n');
          },
        },
      }),
    ).rejects.toThrow(/changed|identity|source path/u);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a regular-file replacement between path validation and open', async () => {
    const root = await fixture();
    const relativeFile = 'src/replaced-before-open.ts';
    const sourceFile = join(root, relativeFile);
    const output = join(dirname(root), 'leaf-replacement-snapshot');
    await writeFile(sourceFile, 'original\n');

    await expect(
      createSourceSnapshot({
        root,
        output,
        files: [...REQUIRED_SOURCE_FILES, relativeFile],
        testHooks: {
          beforeSourceOpen: async (path) => {
            if (path !== relativeFile) {
              return;
            }
            await unlink(sourceFile);
            await writeFile(sourceFile, 'replaced!\n');
          },
        },
      }),
    ).rejects.toThrow(/changed|identity/u);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a FIFO substituted after the leaf check within the watchdog bound', async () => {
    const root = await fixture();
    const relativeFile = 'src/replaced-with-fifo.ts';
    const sourceFile = join(root, relativeFile);
    const output = join(dirname(root), 'fifo-snapshot');
    await writeFile(sourceFile, 'regular file first\n');
    const sourceModule = new URL('../scripts/acceptance/source-snapshot.mjs', import.meta.url).href;
    const childScript = `
      import { execFileSync } from 'node:child_process';
      import { unlink } from 'node:fs/promises';
      import { createSourceSnapshot } from ${JSON.stringify(sourceModule)};
      const [root, output, sourceFile] = process.argv.slice(1);
      await createSourceSnapshot({
        root,
        output,
        files: ${JSON.stringify([...REQUIRED_SOURCE_FILES, relativeFile])},
        testHooks: {
          beforeSourceOpen: async (path) => {
            if (path !== ${JSON.stringify(relativeFile)}) return;
            await unlink(sourceFile);
            execFileSync('mkfifo', [sourceFile]);
          },
        },
      });
    `;
    const result = await runNodeWithWatchdog(childScript, [root, output, sourceFile], 5_000);

    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/FIFO|regular|changed|source/u);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['same-size change', 'size change'])(
    'rejects a %s while the source handle is open',
    async (change) => {
      const root = await fixture();
      const relativeFile = 'src/changed-during-read.ts';
      const sourceFile = join(root, relativeFile);
      const output = join(dirname(root), 'changed-during-read-snapshot');
      await writeFile(sourceFile, 'initial\n');

      await expect(
        createSourceSnapshot({
          root,
          output,
          files: [...REQUIRED_SOURCE_FILES, relativeFile],
          testHooks: {
            beforeSourceRead: async (path) => {
              if (path !== relativeFile) {
                return;
              }
              await writeFile(
                sourceFile,
                change === 'same-size change' ? 'changed\n' : 'larger change\n',
              );
            },
          },
        }),
      ).rejects.toThrow(/changed|identity/u);
      await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('rejects an earlier source changed while a later source is read', async () => {
    const root = await fixture();
    const first = 'src/a-first.ts';
    const later = 'src/z-later.ts';
    const firstPath = join(root, first);
    const laterPath = join(root, later);
    const output = join(dirname(root), 'late-source-change-snapshot');
    await writeFile(firstPath, 'first source\n');
    await writeFile(laterPath, 'later source\n');

    await expect(
      createSourceSnapshot({
        root,
        output,
        files: [...REQUIRED_SOURCE_FILES, first, later],
        testHooks: {
          beforeSourceRead: async (path) => {
            if (path === later) {
              await writeFile(firstPath, 'first changed\n');
            }
          },
        },
      }),
    ).rejects.toThrow(/changed|identity/u);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects production source inventory changes after collection', async () => {
    const root = await fixture();
    const output = join(dirname(root), 'production-inventory-change-snapshot');

    await expect(
      createSourceSnapshot({
        root,
        output,
        files: REQUIRED_SOURCE_FILES,
        testHooks: {
          afterInventory: async () => {
            await writeFile(join(root, 'src', 'added-during-snapshot.ts'), 'export {}\n');
          },
        },
      }),
    ).rejects.toThrow(/inventory|changed|production source/u);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects deletion of a production source after collecting the explicit inventory', async () => {
    const root = await fixture();
    const source = join(root, 'src', 'removed-during-snapshot.ts');
    const output = join(dirname(root), 'production-source-deletion-snapshot');
    await writeFile(source, 'export {}\n');

    await expect(
      createSourceSnapshot({
        root,
        output,
        files: [...REQUIRED_SOURCE_FILES, 'src/removed-during-snapshot.ts'],
        testHooks: {
          afterInventory: async () => unlink(source),
        },
      }),
    ).rejects.toThrow(/ENOENT|source|inventory/u);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an output parent replaced by a symlink and leaves its sentinel untouched', async () => {
    const root = await fixture();
    const outputParent = join(dirname(root), 'staging-parent');
    const movedParent = join(dirname(root), 'original-staging-parent');
    const outsideParent = join(dirname(root), 'outside-staging-parent');
    const output = join(outputParent, 'snapshot');
    const sentinel = join(outsideParent, 'sentinel.txt');
    await mkdir(outputParent);
    await mkdir(outsideParent);
    await writeFile(sentinel, 'OUTPUT_SENTINEL\n');

    await expect(
      createSourceSnapshot({
        root,
        output,
        files: REQUIRED_SOURCE_FILES,
        testHooks: {
          beforeOutputCreate: async () => {
            await rename(outputParent, movedParent);
            await symlink(outsideParent, outputParent, 'dir');
          },
        },
      }),
    ).rejects.toThrow(/changed|identity|output parent/u);
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('OUTPUT_SENTINEL\n');
    await expect(lstat(join(outsideParent, 'snapshot'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an output parent replaced by another directory', async () => {
    const root = await fixture();
    const outputParent = join(dirname(root), 'replaceable-output-parent');
    const movedParent = join(dirname(root), 'old-output-parent');
    const output = join(outputParent, 'snapshot');
    await mkdir(outputParent);

    await expect(
      createSourceSnapshot({
        root,
        output,
        files: REQUIRED_SOURCE_FILES,
        testHooks: {
          beforeOutputCreate: async () => {
            await rename(outputParent, movedParent);
            await mkdir(outputParent);
          },
        },
      }),
    ).rejects.toThrow(/changed|identity|output parent/u);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts an existing empty private output directory', async () => {
    const root = await fixture();
    const output = join(dirname(root), 'existing-private-output');
    await mkdir(output, { mode: 0o700 });

    const result = await createSourceSnapshot({ root, output, files: REQUIRED_SOURCE_FILES });

    expect(result.files).toHaveLength(REQUIRED_SOURCE_FILES.length);
    expect((await lstat(output)).mode & 0o7777).toBe(0o700);
  });

  it('rejects output files and symlinks without changing the target', async () => {
    const root = await fixture();
    const base = dirname(root);
    const regularFile = join(base, 'output-is-a-file');
    const outside = join(base, 'output-link-target');
    const symlinkOutput = join(base, 'output-is-a-symlink');
    await writeFile(regularFile, 'KEEP_FILE\n');
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, 'sentinel'), 'KEEP_TARGET\n', { mode: 0o600 });
    await symlink(outside, symlinkOutput, 'dir');

    await expect(
      createSourceSnapshot({ root, output: regularFile, files: REQUIRED_SOURCE_FILES }),
    ).rejects.toThrow(/directory|output/u);
    await expect(
      createSourceSnapshot({ root, output: symlinkOutput, files: REQUIRED_SOURCE_FILES }),
    ).rejects.toThrow(/directory|output/u);
    await expect(readFile(regularFile, 'utf8')).resolves.toBe('KEEP_FILE\n');
    await expect(readFile(join(outside, 'sentinel'), 'utf8')).resolves.toBe('KEEP_TARGET\n');
  });

  it('rejects an output parent writable by other users', async () => {
    const root = await fixture();
    const outputParent = join(dirname(root), 'untrusted-output-parent');
    await mkdir(outputParent, { mode: 0o700 });
    await chmod(outputParent, 0o777);

    await expect(
      createSourceSnapshot({
        root,
        output: join(outputParent, 'snapshot'),
        files: REQUIRED_SOURCE_FILES,
      }),
    ).rejects.toThrow(/untrusted user|output parent/u);
  });

  it('requires exact directory permissions, including no special bits', async () => {
    const root = await fixture();
    const output = join(dirname(root), 'special-mode-output');
    await mkdir(output, { mode: 0o700 });
    await chmod(output, 0o4700);

    await expect(
      createSourceSnapshot({ root, output, files: REQUIRED_SOURCE_FILES }),
    ).rejects.toThrow(/mode 0700/u);
    expect((await lstat(output)).mode & 0o7777).toBe(0o4700);
  });

  it('rejects a file replaced after writing, even when its bytes are identical', async () => {
    const root = await fixture();
    const output = join(dirname(root), 'replaced-output-file');
    let sourceBytes = '';

    await expect(
      createSourceSnapshot({
        root,
        output,
        files: REQUIRED_SOURCE_FILES,
        testHooks: {
          beforeFinalOutputCheck: async () => {
            const path = join(output, '.nvmrc');
            sourceBytes = await readFile(path, 'utf8');
            await unlink(path);
            await writeFile(path, sourceBytes, { mode: 0o600 });
          },
        },
      }),
    ).rejects.toThrow(/output file|identity|inventory/u);
    expect(sourceBytes).not.toBe('');
  });

  it('rejects an unexpected file added during the final output check', async () => {
    const root = await fixture();
    const output = join(dirname(root), 'unexpected-final-output');

    await expect(
      createSourceSnapshot({
        root,
        output,
        files: REQUIRED_SOURCE_FILES,
        testHooks: {
          beforeFinalOutputCheck: () =>
            writeFile(join(output, 'unexpected.txt'), 'UNEXPECTED\n', { mode: 0o600 }),
        },
      }),
    ).rejects.toThrow(/inventory|changed|output file/u);
    await expect(readFile(join(output, 'unexpected.txt'), 'utf8')).resolves.toBe('UNEXPECTED\n');
  });

  it('rejects the output directory replaced before the final identity check', async () => {
    const root = await fixture();
    const output = join(dirname(root), 'replaced-output-directory');
    const movedOutput = join(dirname(root), 'original-output-directory');

    await expect(
      createSourceSnapshot({
        root,
        output,
        files: REQUIRED_SOURCE_FILES,
        testHooks: {
          beforeFinalOutputCheck: async () => {
            await rename(output, movedOutput);
            await mkdir(output, { mode: 0o700 });
          },
        },
      }),
    ).rejects.toThrow(/output directory identity/u);
    await expect(lstat(join(movedOutput, '.nvmrc'))).resolves.toBeDefined();
    expect(await readdir(output)).toEqual([]);
  });

  it('rejects an output subdirectory replaced before the final identity check', async () => {
    const root = await fixture();
    const output = join(dirname(root), 'replaced-output-subdirectory');
    const movedSourceOutput = join(dirname(root), 'original-output-source');

    await expect(
      createSourceSnapshot({
        root,
        output,
        files: REQUIRED_SOURCE_FILES,
        testHooks: {
          beforeFinalOutputCheck: async () => {
            await rename(join(output, 'src'), movedSourceOutput);
            await mkdir(join(output, 'src'), { mode: 0o700 });
          },
        },
      }),
    ).rejects.toThrow(/output directory identity/u);
    await expect(lstat(join(movedSourceOutput, 'bin', 'revo.ts'))).resolves.toBeDefined();
    expect(await readdir(join(output, 'src'))).toEqual([]);
  });

  it('rejects insecure or populated output without chmod or deleting contents', async () => {
    const root = await fixture();
    const base = dirname(root);
    const insecure = join(base, 'insecure-output');
    const populated = join(base, 'populated-output');
    await mkdir(insecure, { mode: 0o755 });
    await chmod(insecure, 0o755);
    await mkdir(populated, { mode: 0o700 });
    const sentinel = join(populated, 'sentinel.txt');
    await writeFile(sentinel, 'DO_NOT_DELETE\n', { mode: 0o600 });

    await expect(
      createSourceSnapshot({ root, output: insecure, files: REQUIRED_SOURCE_FILES }),
    ).rejects.toThrow(/private|mode|permission/u);
    await expect(
      createSourceSnapshot({ root, output: populated, files: REQUIRED_SOURCE_FILES }),
    ).rejects.toThrow(/empty|nonempty/u);
    expect((await lstat(insecure)).mode & 0o777).toBe(0o755);
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('DO_NOT_DELETE\n');
  });

  it('does not recursively remove partial output after a later write-phase failure', async () => {
    const root = await fixture();
    const output = join(dirname(root), 'partial-output');
    let writes = 0;

    await expect(
      createSourceSnapshot({
        root,
        output,
        files: REQUIRED_SOURCE_FILES,
        testHooks: {
          beforeOutputWrite: () => {
            writes += 1;
            if (writes === 2) {
              throw new Error('deterministic output write failure');
            }
          },
        },
      }),
    ).rejects.toThrow('deterministic output write failure');
    expect((await lstat(output)).mode & 0o777).toBe(0o700);
    await expect(readFile(join(output, '.nvmrc'), 'utf8')).resolves.toBe('fixture:.nvmrc\n');
    await expect(lstat(join(output, 'LICENSE'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function fixture(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'revo-acceptance-source-'));
  roots.push(base);
  const root = join(base, 'source');
  await mkdir(root);
  await Promise.all(
    REQUIRED_SOURCE_FILES.map(async (path) => {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `fixture:${path}\n`);
    }),
  );
  await mkdir(join(root, 'installer'), { recursive: true });
  await writeFile(join(root, 'installer', 'install.sh.in'), 'fixture installer\n');
  return root;
}

function runGit(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function runNodeWithWatchdog(
  script: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolvePromise({ code, output, timedOut });
    });
  });
}
