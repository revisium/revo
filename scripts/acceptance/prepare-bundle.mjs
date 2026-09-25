#!/usr/bin/env node
// oxlint-disable curly -- compact argument validation keeps the acceptance helper auditable.

// Prepare an isolated acceptance copy with one explicitly overridden TUI input.
// The production release snapshot is never edited by this script.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateTuiLockOverride, validateTuiLockSource } from './lockfile-validation.mjs';
import { createSourceSnapshot } from './source-snapshot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TUI_NAME = '@revisium/revo-tui';
const SHA256 = /^[a-f0-9]{64}$/u;

const fail = (message) => {
  throw new Error(`acceptance preparation: ${message}`);
};

const digest = (bytes, algorithm) => createHash(algorithm).update(bytes).digest();
const sha256 = (bytes) => digest(bytes, 'sha256').toString('hex');
const sri = (bytes) => `sha512-${digest(bytes, 'sha512').toString('base64')}`;

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      console.log(
        'Usage: node scripts/acceptance/prepare-bundle.mjs --tui-tarball FILE --tui-url URL --output DIR [--expected-tui-version VERSION] [--source-files INVENTORY.json]',
      );
      process.exit(0);
    }
    if (!argument?.startsWith('--')) fail(`unknown argument ${argument}`);
    const name = argument.slice(2);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) fail(`missing value for --${name}`);
    values.set(name, value);
  }
  const tarball = values.get('tui-tarball');
  const url = values.get('tui-url');
  const output = values.get('output');
  if (typeof tarball !== 'string' || typeof url !== 'string' || typeof output !== 'string') {
    fail('--tui-tarball, --tui-url, and --output are required');
  }
  return {
    tarball: resolve(tarball),
    tuiUrl: url,
    output: resolve(output),
    expectedVersion: values.get('expected-tui-version'),
    sourceFiles: values.has('source-files') ? resolve(values.get('source-files')) : undefined,
  };
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', rejectPromise);
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) resolvePromise({ stdout, stderr });
      else
        rejectPromise(
          new Error(
            `${command} ${args.join(' ')} failed:\nstdout: ${stdout.slice(-4096)}\nstderr: ${stderr.slice(-4096)}`,
          ),
        );
    });
  });
}

function validateUrl(value, expectedSha, expectedName) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('TUI URL is not an absolute HTTPS URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== `?sha256=${expectedSha}` ||
    parsed.hash !== '' ||
    parsed.pathname !== `/tui/${expectedSha}/${expectedName}`
  ) {
    fail('TUI URL must be the exact helper route for the tarball digest');
  }
}

async function packageMetadata(tarball) {
  const result = await run('tar', ['-xOzf', tarball, 'package/package.json']);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('acceptance preparation: TUI tarball has invalid package metadata');
  }
}

async function explicitInventory(path) {
  if (path === undefined) return undefined;
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail('--source-files must reference a readable inventory JSON file');
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.files) ||
    value.files.some((file) => typeof file !== 'string')
  ) {
    fail('--source-files must contain {"schemaVersion":1,"files":[relative paths]}');
  }
  return value.files;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const tuiBytes = await readFile(options.tarball);
  const tuiSha256 = sha256(tuiBytes);
  if (!SHA256.test(tuiSha256)) fail('could not compute TUI SHA256');
  validateUrl(options.tuiUrl, tuiSha256, basename(options.tarball));
  const metadata = await packageMetadata(options.tarball);
  if (sha256(await readFile(options.tarball)) !== tuiSha256) {
    fail('TUI tarball changed while its package metadata was read');
  }
  if (metadata.name !== TUI_NAME || typeof metadata.version !== 'string') {
    fail('TUI tarball package identity is invalid');
  }
  if (options.expectedVersion !== undefined && metadata.version !== options.expectedVersion) {
    fail(`TUI version ${metadata.version} does not match ${options.expectedVersion}`);
  }

  const sourceInventory = await explicitInventory(options.sourceFiles);
  const snapshot = await createSourceSnapshot({
    root: ROOT,
    output: options.output,
    ...(sourceInventory === undefined ? {} : { files: sourceInventory }),
  });
  await mkdir(join(options.output, 'dist'), { recursive: true, mode: 0o700 });
  const sourcePackageBytes = await readFile(join(options.output, 'package.json'));
  const sourcePackage = JSON.parse(sourcePackageBytes.toString('utf8'));
  const sourceLock = await readFile(join(options.output, 'pnpm-lock.yaml'));
  const sourceWorkspace = await readFile(join(options.output, 'pnpm-workspace.yaml'));
  const sourceHash = (path) => snapshot.files.find((file) => file.path === path)?.sha256;
  if (
    sha256(sourcePackageBytes) !== sourceHash('package.json') ||
    sha256(sourceLock) !== sourceHash('pnpm-lock.yaml') ||
    sha256(sourceWorkspace) !== sourceHash('pnpm-workspace.yaml')
  ) {
    fail('source snapshot hashes do not match the files being prepared');
  }
  if (sourcePackage.dependencies?.[TUI_NAME] === undefined)
    fail('Revo has no direct TUI dependency');

  const expectedArtifact = {
    name: metadata.name,
    version: metadata.version,
    url: options.tuiUrl,
    integrity: sri(tuiBytes),
    tarballSha256: tuiSha256,
  };
  const sourceLockValidation = validateTuiLockSource({
    sourceLock,
    sourcePackage,
    expected: expectedArtifact,
  });

  const stagedPackagePath = join(options.output, 'package.json');
  const stagedPackage = JSON.parse(await readFile(stagedPackagePath, 'utf8'));
  stagedPackage.dependencies[TUI_NAME] = options.tuiUrl;
  await writeFile(stagedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`, {
    mode: 0o600,
  });
  const stagedWorkspace = sourceWorkspace;
  await writeFile(join(options.output, 'pnpm-workspace.yaml'), stagedWorkspace, { mode: 0o600 });

  await run(
    'pnpm',
    [
      'install',
      '--lockfile-only',
      '--ignore-scripts',
      '--no-frozen-lockfile',
      '--pm-on-fail=error',
      '--config.strict-ssl=true',
    ],
    { cwd: options.output },
  );
  const stagedLock = await readFile(join(options.output, 'pnpm-lock.yaml'));
  const stagedPackageBytes = await readFile(join(options.output, 'package.json'));
  const verifiedStagedPackage = JSON.parse(stagedPackageBytes.toString('utf8'));
  const verifiedWorkspace = await readFile(join(options.output, 'pnpm-workspace.yaml'));
  if (!verifiedWorkspace.equals(sourceWorkspace)) {
    fail('pnpm changed the staging workspace manifest');
  }
  const lockValidation = validateTuiLockOverride({
    beforeLock: sourceLock,
    afterLock: stagedLock,
    sourcePackage,
    stagedPackage: verifiedStagedPackage,
    expected: expectedArtifact,
  });
  if (
    lockValidation.sourceLockSha256 !== sourceLockValidation.sourceLockSha256 ||
    lockValidation.sourcePackageKey !== sourceLockValidation.sourcePackageKey ||
    lockValidation.sourceSnapshotKey !== sourceLockValidation.sourceSnapshotKey ||
    lockValidation.peerSuffix !== sourceLockValidation.peerSuffix
  ) {
    fail('source lock binding changed between preflight and staging validation');
  }

  const input = {
    schemaVersion: 1,
    sourceRevision: process.env.GITHUB_SHA ?? null,
    sourceFiles: snapshot.files,
    sourcePackageSha256: snapshot.files.find(({ path }) => path === 'package.json').sha256,
    sourceLockSha256: snapshot.files.find(({ path }) => path === 'pnpm-lock.yaml').sha256,
    sourceWorkspaceSha256: snapshot.files.find(({ path }) => path === 'pnpm-workspace.yaml').sha256,
    stagingLockSha256: sha256(Buffer.from(stagedLock)),
    stagingWorkspaceSha256: sha256(verifiedWorkspace),
    stagingPackageSha256: sha256(stagedPackageBytes),
    lockValidation,
    tui: {
      name: metadata.name,
      version: metadata.version,
      tarballSha256: tuiSha256,
      integrity: sri(tuiBytes),
      url: options.tuiUrl,
    },
    override: {
      dependency: TUI_NAME,
      mode: 'exact-https-tarball',
    },
  };
  if (
    input.lockValidation.sourceLockSha256 !== input.sourceLockSha256 ||
    input.lockValidation.stagingLockSha256 !== input.stagingLockSha256 ||
    input.stagingWorkspaceSha256 !== input.sourceWorkspaceSha256
  ) {
    fail('acceptance receipt hashes are inconsistent');
  }
  const verifiedInputHashes = await Promise.all(
    [
      ['package.json', input.stagingPackageSha256],
      ['pnpm-lock.yaml', input.stagingLockSha256],
      ['pnpm-workspace.yaml', input.stagingWorkspaceSha256],
    ].map(async ([path, expectedHash]) => [
      path,
      expectedHash,
      sha256(await readFile(join(options.output, path))),
    ]),
  );
  for (const [path, expectedHash, actualHash] of verifiedInputHashes) {
    if (actualHash !== expectedHash) {
      fail(`staging input changed before receipt publication: ${path}`);
    }
  }
  const receiptPath = join(options.output, 'acceptance-input.json');
  const receiptTempPath = join(options.output, `.acceptance-input.${process.pid}.tmp`);
  try {
    await lstat(receiptPath);
    fail('acceptance receipt already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeFile(receiptTempPath, `${JSON.stringify(input, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await rename(receiptTempPath, receiptPath);
  process.stdout.write(`${JSON.stringify({ output: options.output, ...input.tui })}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
}
