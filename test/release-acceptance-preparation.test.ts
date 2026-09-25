import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { REQUIRED_SOURCE_FILES } from '../scripts/acceptance/source-snapshot.mjs';

const script = join(process.cwd(), 'scripts', 'acceptance', 'prepare-bundle.mjs');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release acceptance preparation', () => {
  it('stages only build inputs and receipts their original bytes before TUI override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-release-preparation-'));
    roots.push(root);
    const sourceRoot = process.cwd();
    const tools = join(root, 'tools');
    const packageRoot = join(root, 'tui-package', 'package');
    const tarball = join(root, 'revisium-revo-tui-0.0.0.tgz');
    const inventoryPath = join(root, 'source-files.json');
    const output = join(root, 'staging');
    await mkdir(tools);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@revisium/revo-tui',
        version: '0.0.0',
      }),
    );
    run('tar', ['-czf', tarball, '-C', join(root, 'tui-package'), 'package']);

    const inventory = await sourceInventory(sourceRoot);
    const originalSourceFiles = new Map(
      await Promise.all(
        inventory.map(
          async (path) => [path, await readFile(join(sourceRoot, ...path.split('/')))] as const,
        ),
      ),
    );
    await writeFile(inventoryPath, JSON.stringify({ schemaVersion: 1, files: inventory }));
    const pnpmShim = join(root, 'pnpm-shim.mjs');
    const pnpmCalls = join(root, 'pnpm-calls.log');
    await writeFile(
      pnpmShim,
      `import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
const require = createRequire(process.env.PROJECT_ROOT + '/package.json');
const { parseAllDocuments, stringify } = require('yaml');
await appendFile(process.env.PNPM_CALL_MARKER, 'called\\n');
const lockBytes = await readFile('pnpm-lock.yaml');
const documents = parseAllDocuments(lockBytes.toString('utf8')).map((document) => document.toJS({ mapAsMap: true }));
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const url = manifest.dependencies['@revisium/revo-tui'];
const bytes = await readFile(process.env.TUI_TARBALL);
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const application = documents[1];
const dependency = application.get('importers').get('.').get('dependencies').get('@revisium/revo-tui');
const sourceVersion = process.env.TUI_SOURCE_VERSION;
const suffix = dependency.get('version').slice(sourceVersion.length);
const sourcePackageKey = '@revisium/revo-tui@' + sourceVersion;
const sourceSnapshotKey = sourcePackageKey + suffix;
const targetPackageKey = '@revisium/revo-tui@' + url;
const targetSnapshotKey = targetPackageKey + suffix;
dependency.set('specifier', url);
dependency.set('version', url + suffix);
const packageRecord = application.get('packages').get(sourcePackageKey);
packageRecord.set('resolution', new Map([['integrity', integrity], ['tarball', url]]));
packageRecord.set('version', '0.0.0');
application.get('packages').delete(sourcePackageKey);
application.get('packages').set(targetPackageKey, packageRecord);
const snapshot = application.get('snapshots').get(sourceSnapshotKey);
application.get('snapshots').delete(sourceSnapshotKey);
application.get('snapshots').set(targetSnapshotKey, snapshot);
if (process.env.PNPM_DRIFT === '1') documents[0].set('unexpectedDrift', true);
await writeFile('pnpm-lock.yaml', documents.map((document) => stringify(document)).join('---\\n'));
`,
    );
    const fakePnpm = join(tools, 'pnpm');
    await writeFile(fakePnpm, '#!/bin/sh\nexec "$PNPM_TEST_NODE" "$PNPM_TEST_SCRIPT"\n', {
      mode: 0o700,
    });
    await chmod(fakePnpm, 0o700);

    const tuiSha = createHash('sha256')
      .update(await readFile(tarball))
      .digest('hex');
    const tuiUrl = `https://127.0.0.1:8443/tui/${tuiSha}/${tarball.split('/').at(-1)}?sha256=${tuiSha}`;
    const result = await runNode(
      [
        script,
        '--tui-tarball',
        tarball,
        '--tui-url',
        tuiUrl,
        '--output',
        output,
        '--source-files',
        inventoryPath,
      ],
      {
        PATH: `${tools}:${process.env.PATH ?? ''}`,
        PNPM_TEST_NODE: process.execPath,
        PNPM_TEST_SCRIPT: pnpmShim,
        PNPM_CALL_MARKER: pnpmCalls,
        TUI_TARBALL: tarball,
        TUI_SOURCE_VERSION: JSON.parse(
          (await readFile(join(sourceRoot, 'package.json'))).toString('utf8'),
        ).dependencies['@revisium/revo-tui'],
        PROJECT_ROOT: sourceRoot,
      },
    );

    expect(result.code).toBe(0);
    const receipt = JSON.parse(await readFile(join(output, 'acceptance-input.json'), 'utf8'));
    const sourcePackage = await readFile(join(sourceRoot, 'package.json'));
    expect(receipt.sourcePackageSha256).toBe(
      createHash('sha256').update(sourcePackage).digest('hex'),
    );
    expect(receipt.tui.url).toBe(tuiUrl);
    expect(receipt.lockValidation).toMatchObject({
      policy: 'revo-tui-lock-override-v1',
      url: tuiUrl,
      tarballSha256: tuiSha,
      sourceLockSha256: receipt.sourceLockSha256,
      stagingLockSha256: receipt.stagingLockSha256,
    });
    expect(receipt.sourceFiles).toContainEqual({
      path: 'package.json',
      sha256: receipt.sourcePackageSha256,
    });
    for (const file of receipt.sourceFiles) {
      const original = originalSourceFiles.get(file.path);
      if (original === undefined) {
        throw new Error(`unexpected receipt file ${file.path}`);
      }
      expect(file.sha256).toBe(createHash('sha256').update(original).digest('hex'));
    }
    expect(await readFile(join(output, 'package.json'), 'utf8')).toContain(tuiUrl);
    await expect(readFile(join(output, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(output, 'test', 'release-bundle.test.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(join(output, 'scripts', 'acceptance', 'source-snapshot.mjs')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(output, 'pnpm-lock.yaml'), 'utf8')).resolves.toContain(tuiUrl);

    const driftOutput = join(root, 'drift-staging');
    const driftResult = await runNode(
      [
        script,
        '--tui-tarball',
        tarball,
        '--tui-url',
        tuiUrl,
        '--output',
        driftOutput,
        '--source-files',
        inventoryPath,
      ],
      {
        PATH: `${tools}:${process.env.PATH ?? ''}`,
        PNPM_TEST_NODE: process.execPath,
        PNPM_TEST_SCRIPT: pnpmShim,
        PNPM_CALL_MARKER: pnpmCalls,
        TUI_TARBALL: tarball,
        TUI_SOURCE_VERSION: JSON.parse(
          (await readFile(join(sourceRoot, 'package.json'))).toString('utf8'),
        ).dependencies['@revisium/revo-tui'],
        PROJECT_ROOT: sourceRoot,
        PNPM_DRIFT: '1',
      },
    );
    expect(driftResult.code).not.toBe(0);
    expect(driftResult.output).toContain('staging toolchain document changed');
    await expect(readFile(join(driftOutput, 'acceptance-input.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const invalidInventoryPath = join(root, 'invalid-source-files.json');
    const invalidOutput = join(root, 'invalid-staging');
    const pnpmCallMarker = join(root, 'unexpected-pnpm-call');
    await writeFile(
      invalidInventoryPath,
      JSON.stringify({ schemaVersion: 1, files: [...inventory, '../outside.ts'] }),
    );
    const invalidResult = await runNode(
      [
        script,
        '--tui-tarball',
        tarball,
        '--tui-url',
        tuiUrl,
        '--output',
        invalidOutput,
        '--source-files',
        invalidInventoryPath,
      ],
      {
        PATH: `${tools}:${process.env.PATH ?? ''}`,
        PNPM_TEST_NODE: process.execPath,
        PNPM_TEST_SCRIPT: pnpmShim,
        PNPM_CALL_MARKER: pnpmCallMarker,
        TUI_TARBALL: tarball,
        TUI_SOURCE_VERSION: JSON.parse(
          (await readFile(join(sourceRoot, 'package.json'))).toString('utf8'),
        ).dependencies['@revisium/revo-tui'],
        PROJECT_ROOT: sourceRoot,
      },
    );
    expect(invalidResult.code).not.toBe(0);
    await expect(readFile(pnpmCallMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(invalidOutput, 'acceptance-input.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await Promise.all(
      [...originalSourceFiles].map(async ([path, original]) => {
        await expect(readFile(join(sourceRoot, ...path.split('/')))).resolves.toEqual(original);
      }),
    );
  }, 15_000);
});

async function sourceInventory(root: string): Promise<string[]> {
  const files = [...REQUIRED_SOURCE_FILES];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(`source fixture contains a symlink: ${path}`);
        }
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          files.push(relative(root, path).split(sep).join('/'));
        }
      }),
    );
  };
  await visit(join(root, 'src'));
  return [...new Set(files)].sort();
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function runNode(
  args: string[],
  extraEnvironment: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise({ code, output }));
  });
}
