import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  verifyHandoffReceipt,
  verifyStagingReceipt,
} from '../scripts/acceptance/preparation-receipt.mjs';

const NAME = '@revisium/revo-tui';
const VERSION = '0.0.0';
const PEER_SUFFIX = '(react@19.0.0)';
const roots: string[] = [];
const receiptCli = fileURLToPath(
  new URL('../scripts/acceptance/preparation-receipt.mjs', import.meta.url),
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('acceptance preparation receipt', () => {
  it('verifies the staged package, lock, workspace, receipt and actual TUI bytes', async () => {
    const subject = await createSubject();
    const receipt = await verifyStagingReceipt({
      root: subject.stage,
      tarballPath: subject.tarball,
    });
    expect(receipt.lockValidation.policy).toBe('revo-tui-lock-override-v1');
  });

  it('accepts the exact staging CLI argv used by the workflow and rejects extra arguments', async () => {
    const subject = await createSubject();
    const valid = spawnSync(
      process.execPath,
      [receiptCli, 'staging', subject.stage, subject.tarball],
      { encoding: 'utf8' },
    );
    expect({ status: valid.status, stderr: valid.stderr }).toMatchObject({ status: 0 });

    const extra = spawnSync(
      process.execPath,
      [receiptCli, 'staging', subject.stage, subject.tarball, 'unexpected'],
      { encoding: 'utf8' },
    );
    expect(extra.status).toBe(1);
    expect(extra.stderr).toMatch(/usage:/u);
  });

  it('rejects a TUI archive whose SRI differs despite a valid receipt SHA field', async () => {
    const subject = await createSubject();
    await writeFile(subject.tarball, 'different package bytes');
    await expect(
      verifyStagingReceipt({ root: subject.stage, tarballPath: subject.tarball }),
    ).rejects.toThrow(/SHA256\/SRI/u);
  });

  it('rejects missing structural validation receipt and mismatched package bytes', async () => {
    const missing = await createSubject();
    const input = JSON.parse(await readFile(join(missing.stage, 'acceptance-input.json'), 'utf8'));
    delete input.lockValidation;
    await writeFile(join(missing.stage, 'acceptance-input.json'), JSON.stringify(input));
    await expect(
      verifyStagingReceipt({ root: missing.stage, tarballPath: missing.tarball }),
    ).rejects.toThrow(/lock validation receipt/u);

    const changed = await createSubject();
    await writeFile(join(changed.stage, 'package.json'), '{"name":"changed"}');
    await expect(
      verifyStagingReceipt({ root: changed.stage, tarballPath: changed.tarball }),
    ).rejects.toThrow(/package, lock, workspace/u);
  });

  it('validates bundle hashes and manifest/report linkage on a consumer without YAML tooling', async () => {
    const subject = await createSubject();
    const handoff = await createHandoffFixture(subject);
    const result = await verifyHandoffReceipt({
      root: handoff.root,
      bundleRoot: handoff.bundle,
      tarballPath: handoff.tarball,
    });
    const cli = spawnSync(
      process.execPath,
      [receiptCli, 'handoff', handoff.root, handoff.bundle, handoff.tarball],
      { encoding: 'utf8' },
    );
    expect({ status: cli.status, stderr: cli.stderr }).toMatchObject({ status: 0 });
    expect(result.tui.tarballSha256).toBe(subject.tarballSha256);
    expect(
      await readFile(
        new URL('../scripts/acceptance/preparation-receipt.mjs', import.meta.url),
        'utf8',
      ),
    ).not.toMatch(/from ['"]yaml['"]/u);
  });

  it('compares ordinary JSON object keys without order while preserving array order', async () => {
    const subject = await createSubject();
    const handoff = await createHandoffFixture(subject);
    const packageManifest = subject.packageManifest;
    const reordered = {
      ...packageManifest,
      dependencies: Object.fromEntries(Object.entries(packageManifest.dependencies).reverse()),
      scripts: Object.fromEntries(Object.entries(packageManifest.scripts).reverse()),
      peerDependenciesMeta: {
        typescript: { label: 'runtime', optional: false },
        react: { label: 'ui', optional: true },
      },
    };
    await handoff.writePackedPackage(reordered);

    await expect(
      verifyHandoffReceipt({
        root: handoff.root,
        bundleRoot: handoff.bundle,
        tarballPath: handoff.tarball,
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    [
      'changed value',
      (manifest: typeof basePackageManifest) => ({
        ...manifest,
        dependencies: { ...manifest.dependencies, 'fixture-a': '9.9.9' },
      }),
    ],
    [
      'added key',
      (manifest: typeof basePackageManifest) => ({
        ...manifest,
        dependencies: { ...manifest.dependencies, 'fixture-new': '3.0.0' },
      }),
    ],
    [
      'changed JSON type',
      (manifest: typeof basePackageManifest) => ({
        ...manifest,
        dependencies: { ...manifest.dependencies, 'fixture-a': 1 },
      }),
    ],
    [
      'missing field',
      (manifest: typeof basePackageManifest) => {
        const { scripts: _scripts, ...withoutScripts } = manifest;
        return withoutScripts;
      },
    ],
    [
      'null instead of a missing field',
      (manifest: typeof basePackageManifest) => ({ ...manifest, scripts: null }),
    ],
    [
      'empty object instead of a populated field',
      (manifest: typeof basePackageManifest) => ({ ...manifest, scripts: {} }),
    ],
    [
      'array instead of object',
      (manifest: typeof basePackageManifest) => ({ ...manifest, scripts: [] }),
    ],
    [
      'array order',
      (manifest: typeof basePackageManifest) => ({
        ...manifest,
        files: [...manifest.files].reverse(),
      }),
    ],
    [
      'conditional exports order',
      (manifest: typeof basePackageManifest) => ({
        ...manifest,
        exports: {
          '.': {
            require: './index.cjs',
            import: './index.js',
            types: './index.d.ts',
          },
        },
      }),
    ],
  ])('rejects packed manifest drift in %s', async (_label, alterPackage) => {
    const subject = await createSubject();
    const handoff = await createHandoffFixture(subject);
    await handoff.writePackedPackage(alterPackage(subject.packageManifest));

    await expect(
      verifyHandoffReceipt({
        root: handoff.root,
        bundleRoot: handoff.bundle,
        tarballPath: handoff.tarball,
      }),
    ).rejects.toThrow(/unexpected packed field drift/u);
  });
});

const basePackageManifest = {
  name: '@revisium/revo',
  version: '1.0.0',
  packageManager: 'pnpm@12.5.1',
  dependencies: {
    [NAME]: 'https://127.0.0.1:8443/tui/hash/revo-tui.tgz?sha256=hash',
    'fixture-a': '1.0.0',
    'fixture-z': '2.0.0',
  },
  peerDependenciesMeta: {
    react: { optional: true, label: 'ui' },
    typescript: { optional: false, label: 'runtime' },
  },
  exports: {
    '.': { types: './index.d.ts', import: './index.js', require: './index.cjs' },
  },
  files: ['dist', 'src'],
  os: ['linux', 'darwin'],
  cpu: ['x64', 'arm64'],
  scripts: { build: 'node build.mjs', test: 'node test.mjs' },
};

async function createHandoffFixture(subject: Awaited<ReturnType<typeof createSubject>>) {
  const handoffRoot = join(subject.root, 'handoff');
  const bundle = join(handoffRoot, 'revo-bundle');
  const tui = join(handoffRoot, 'tui');
  await mkdir(bundle, { recursive: true });
  await mkdir(tui, { recursive: true });
  await writeFile(
    join(handoffRoot, 'acceptance-input.json'),
    await readFile(join(subject.stage, 'acceptance-input.json')),
  );
  await writeFile(
    join(handoffRoot, 'prepared-package.json'),
    await readFile(join(subject.stage, 'package.json')),
  );
  await writeFile(
    join(handoffRoot, 'prepared-pnpm-lock.yaml'),
    await readFile(join(subject.stage, 'pnpm-lock.yaml')),
  );
  await writeFile(
    join(handoffRoot, 'prepared-pnpm-workspace.yaml'),
    await readFile(join(subject.stage, 'pnpm-workspace.yaml')),
  );
  await writeFile(join(tui, 'revo-tui.tgz'), await readFile(subject.tarball));
  const packageBytes = Buffer.from(JSON.stringify(subject.packageManifest));
  const lockBytes = await readFile(join(subject.stage, 'pnpm-lock.yaml'));
  const workspaceBytes = await readFile(join(subject.stage, 'pnpm-workspace.yaml'));
  await writeFile(join(bundle, 'package.json'), packageBytes);
  await writeFile(join(bundle, 'pnpm-lock.yaml'), lockBytes);
  await writeFile(join(bundle, 'pnpm-workspace.yaml'), workspaceBytes);
  const packageArchive = Buffer.from('synthetic Revo package archive');
  const channelBytes = Buffer.from(JSON.stringify({ version: '1.0.0' }));
  const installerBytes = Buffer.from('#!/bin/sh\n');
  await writeFile(join(bundle, 'revo-1.0.0.tgz'), packageArchive);
  await writeFile(join(bundle, 'channel.json'), channelBytes);
  await writeFile(join(bundle, 'install.sh'), installerBytes);
  const manifest = {
    schemaVersion: 'revo-install/v3',
    release: { version: '1.0.0' },
    artifacts: {
      packageJson: { sha256: sha(packageBytes) },
      pnpmLock: { sha256: sha(lockBytes) },
      pnpmWorkspace: { sha256: sha(workspaceBytes) },
      package: { sha256: sha(packageArchive), integrity: sri(packageArchive) },
    },
  };
  const report = {
    schemaVersion: 'revo-release-bundle/v1',
    status: 'verified',
    release: { version: '1.0.0' },
    artifacts: {
      packageJson: sha(packageBytes),
      pnpmLock: sha(lockBytes),
      pnpmWorkspace: sha(workspaceBytes),
      package: sha(packageArchive),
      manifest: '',
      channel: sha(channelBytes),
      installer: sha(installerBytes),
    },
  };

  async function writePackedPackage(packageManifest: object) {
    const packedBytes = Buffer.from(JSON.stringify(packageManifest));
    manifest.artifacts.packageJson.sha256 = sha(packedBytes);
    report.artifacts.packageJson = sha(packedBytes);
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    report.artifacts.manifest = sha(manifestBytes);
    await writeFile(join(bundle, 'package.json'), packedBytes);
    await writeFile(join(bundle, 'manifest.json'), manifestBytes);
    await writeFile(join(bundle, 'release-bundle-report.json'), JSON.stringify(report));
  }

  await writePackedPackage(subject.packageManifest);
  return {
    root: handoffRoot,
    bundle,
    tarball: join(tui, 'revo-tui.tgz'),
    writePackedPackage,
  };
}

async function createSubject() {
  const root = await mkdtemp(join(tmpdir(), 'revo-acceptance-receipt-'));
  roots.push(root);
  const stage = join(root, 'stage');
  await mkdir(stage);
  const tarball = join(root, 'revo-tui.tgz');
  const tarballBytes = Buffer.from('verified TUI tarball fixture');
  await writeFile(tarball, tarballBytes);
  const tarballSha256 = sha(tarballBytes);
  const url = `https://127.0.0.1:8443/tui/${tarballSha256}/revo-tui.tgz?sha256=${tarballSha256}`;
  const packageManifest = {
    ...basePackageManifest,
    dependencies: { ...basePackageManifest.dependencies, [NAME]: url },
  };
  const packageJson = Buffer.from(JSON.stringify(packageManifest));
  const lock = Buffer.from('staged lock fixture\n');
  const workspace = Buffer.from('packages: []\n');
  await writeFile(join(stage, 'package.json'), packageJson);
  await writeFile(join(stage, 'pnpm-lock.yaml'), lock);
  await writeFile(join(stage, 'pnpm-workspace.yaml'), workspace);
  const sourcePackage = Buffer.from('source package\n');
  const sourceLock = Buffer.from('source lock\n');
  const sourceWorkspace = workspace;
  const receipt = {
    schemaVersion: 1,
    sourceRevision: null,
    sourceFiles: [
      { path: 'package.json', sha256: sha(sourcePackage) },
      { path: 'pnpm-lock.yaml', sha256: sha(sourceLock) },
      { path: 'pnpm-workspace.yaml', sha256: sha(sourceWorkspace) },
    ],
    sourcePackageSha256: sha(sourcePackage),
    sourceLockSha256: sha(sourceLock),
    sourceWorkspaceSha256: sha(sourceWorkspace),
    stagingPackageSha256: sha(packageJson),
    stagingLockSha256: sha(lock),
    stagingWorkspaceSha256: sha(workspace),
    lockValidation: {
      policy: 'revo-tui-lock-override-v1',
      documentCount: 2,
      applicationDocumentIndex: 1,
      importer: '.',
      dependency: NAME,
      sourceLockSha256: sha(sourceLock),
      stagingLockSha256: sha(lock),
      sourcePackageKey: `${NAME}@0.1.0-alpha.1`,
      targetPackageKey: `${NAME}@${url}`,
      sourceSnapshotKey: `${NAME}@0.1.0-alpha.1${PEER_SUFFIX}`,
      targetSnapshotKey: `${NAME}@${url}${PEER_SUFFIX}`,
      peerSuffix: PEER_SUFFIX,
      url,
      integrity: sri(tarballBytes),
      tarballSha256,
      version: VERSION,
    },
    tui: { name: NAME, version: VERSION, tarballSha256, integrity: sri(tarballBytes), url },
    override: { dependency: NAME, mode: 'exact-https-tarball' },
  };
  await writeFile(join(stage, 'acceptance-input.json'), JSON.stringify(receipt));
  return { root, stage, tarball, tarballSha256, packageManifest };
}

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sri(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}
