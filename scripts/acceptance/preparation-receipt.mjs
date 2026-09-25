import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const POLICY = 'revo-tui-lock-override-v1';
const TUI_NAME = '@revisium/revo-tui';
const SHA256 = /^[a-f0-9]{64}$/u;
const SRI_SHA512 = /^sha512-([A-Za-z0-9+/]{86}==)$/u;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_LOCK_BYTES = 8 * 1024 * 1024;
const MAX_TARBALL_BYTES = 512 * 1024 * 1024;

function fail(message) {
  throw new Error(`acceptance receipt: ${message}`);
}

function digest(bytes, algorithm = 'sha256') {
  return createHash(algorithm).update(bytes).digest('hex');
}

function integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function hasUrlControlOrSpace(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) {
      return true;
    }
    if (character === '\\') {
      return true;
    }
  }
  return false;
}

async function readRegularFile(path, limit) {
  let handle;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > limit) {
      fail(
        `input is not a bounded regular file: ${relative(process.cwd(), path).split(sep).join('/')}`,
      );
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== info.size || opened.size > limit) {
      fail('input changed while it was opened');
    }
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size || bytes.length > limit) {
      fail('input changed while it was read');
    }
    return bytes;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail('required receipt input is missing');
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseJson(bytes, description) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail(`${description} is not valid JSON`);
  }
}

function object(value, description) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${description} must be an object`);
  }
  return value;
}

function validHash(value, description) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail(`${description} is invalid`);
  }
  return value;
}

function validateUrl(url, tarballSha256) {
  if (typeof url !== 'string' || hasUrlControlOrSpace(url)) {
    fail('TUI URL is invalid');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail('TUI URL is not absolute');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    parsed.search !== `?sha256=${tarballSha256}` ||
    !/^\/tui\/[a-f0-9]{64}\/[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(parsed.pathname) ||
    parsed.pathname.split('/').some((part) => part === '.' || part === '..') ||
    parsed.href !== url
  ) {
    fail('TUI URL does not match the exact local artifact route');
  }
  const filename = parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1);
  if (
    !parsed.pathname.includes(`/tui/${tarballSha256}/`) ||
    filename === '.' ||
    filename === '..'
  ) {
    fail('TUI URL does not bind the expected tarball digest');
  }
  return { filename };
}

function validateSourceFiles(input) {
  if (!Array.isArray(input.sourceFiles)) {
    fail('source file inventory is missing');
  }
  const byPath = new Map();
  for (const entryValue of input.sourceFiles) {
    const entry = object(entryValue, 'source file inventory entry');
    if (
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      entry.path.includes('\\') ||
      entry.path.startsWith('/') ||
      entry.path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      byPath.has(entry.path)
    ) {
      fail('source file inventory contains an invalid or duplicate path');
    }
    byPath.set(entry.path, validHash(entry.sha256, `source hash for ${entry.path}`));
  }
  for (const [path, receiptField] of [
    ['package.json', 'sourcePackageSha256'],
    ['pnpm-lock.yaml', 'sourceLockSha256'],
    ['pnpm-workspace.yaml', 'sourceWorkspaceSha256'],
  ]) {
    if (byPath.get(path) !== validHash(input[receiptField], receiptField)) {
      fail(`source inventory does not match ${receiptField}`);
    }
  }
}

function validateReceipt(input, tarballBytes) {
  object(input, 'acceptance input');
  if (input.schemaVersion !== 1) {
    fail('acceptance input schema is unsupported');
  }
  validateSourceFiles(input);
  const tui = object(input.tui, 'TUI receipt');
  const lock = object(input.lockValidation, 'lock validation receipt');
  const override = object(input.override, 'override receipt');
  const sha = validHash(tui.tarballSha256, 'TUI tarball SHA256');
  const route = validateUrl(tui.url, sha);
  if (
    tui.name !== TUI_NAME ||
    typeof tui.version !== 'string' ||
    override.dependency !== TUI_NAME ||
    override.mode !== 'exact-https-tarball' ||
    lock.policy !== POLICY ||
    lock.documentCount !== 2 ||
    lock.applicationDocumentIndex !== 1 ||
    lock.importer !== '.' ||
    lock.dependency !== TUI_NAME ||
    lock.url !== tui.url ||
    lock.version !== tui.version ||
    lock.integrity !== tui.integrity ||
    lock.tarballSha256 !== sha
  ) {
    fail('acceptance input and lock validation receipt disagree');
  }
  const sourceLockHash = validHash(lock.sourceLockSha256, 'validated source lock hash');
  const stagingLockHash = validHash(lock.stagingLockSha256, 'validated staging lock hash');
  if (
    sourceLockHash !== validHash(input.sourceLockSha256, 'source lock hash') ||
    stagingLockHash !== validHash(input.stagingLockSha256, 'staging lock hash') ||
    validHash(input.stagingWorkspaceSha256, 'staging workspace hash') !==
      validHash(input.sourceWorkspaceSha256, 'source workspace hash')
  ) {
    fail('acceptance input lock/workspace hashes disagree with validation receipt');
  }
  if (
    typeof lock.sourcePackageKey !== 'string' ||
    !lock.sourcePackageKey.startsWith(`${TUI_NAME}@`) ||
    typeof lock.sourceSnapshotKey !== 'string' ||
    !lock.sourceSnapshotKey.startsWith(`${lock.sourcePackageKey}`) ||
    typeof lock.peerSuffix !== 'string' ||
    lock.targetPackageKey !== `${TUI_NAME}@${tui.url}` ||
    lock.targetSnapshotKey !== `${lock.targetPackageKey}${lock.peerSuffix}` ||
    lock.sourceSnapshotKey !== `${lock.sourcePackageKey}${lock.peerSuffix}`
  ) {
    fail('TUI package and snapshot locators are inconsistent');
  }
  const sriMatch = typeof tui.integrity === 'string' ? SRI_SHA512.exec(tui.integrity) : null;
  if (
    sriMatch === null ||
    Buffer.from(sriMatch[1], 'base64').length !== 64 ||
    Buffer.from(sriMatch[1], 'base64').toString('base64') !== sriMatch[1]
  ) {
    fail('TUI integrity is not canonical SHA512 SRI');
  }
  if (digest(tarballBytes) !== sha || integrity(tarballBytes) !== tui.integrity) {
    fail('TUI tarball bytes do not match the receipt SHA256/SRI');
  }
  return { input, route };
}

export async function verifyStagingReceipt({ root, tarballPath }) {
  const [receiptBytes, packageBytes, lockBytes, workspaceBytes, tarballBytes] = await Promise.all([
    readRegularFile(join(root, 'acceptance-input.json'), MAX_RECEIPT_BYTES),
    readRegularFile(join(root, 'package.json'), MAX_MANIFEST_BYTES),
    readRegularFile(join(root, 'pnpm-lock.yaml'), MAX_LOCK_BYTES),
    readRegularFile(join(root, 'pnpm-workspace.yaml'), MAX_MANIFEST_BYTES),
    readRegularFile(tarballPath, MAX_TARBALL_BYTES),
  ]);
  const { input, route } = validateReceipt(
    parseJson(receiptBytes, 'acceptance input'),
    tarballBytes,
  );
  const packageJson = object(
    parseJson(packageBytes, 'staging package manifest'),
    'staging package',
  );
  if (
    digest(packageBytes) !== validHash(input.stagingPackageSha256, 'staging package hash') ||
    digest(lockBytes) !== input.lockValidation.stagingLockSha256 ||
    digest(workspaceBytes) !== validHash(input.stagingWorkspaceSha256, 'staging workspace hash') ||
    packageJson.dependencies?.[TUI_NAME] !== input.tui.url
  ) {
    fail('staging package, lock, workspace, or receipt changed after preparation');
  }
  if (route.filename !== tarballPath.split(/[\\/]/u).at(-1)) {
    fail('TUI tarball filename differs from the validated URL');
  }
  return input;
}

export async function verifyHandoffReceipt({ root, bundleRoot, tarballPath }) {
  const [receiptBytes, packageBytes, lockBytes, workspaceBytes, tarballBytes] = await Promise.all([
    readRegularFile(join(root, 'acceptance-input.json'), MAX_RECEIPT_BYTES),
    readRegularFile(join(root, 'prepared-package.json'), MAX_MANIFEST_BYTES),
    readRegularFile(join(root, 'prepared-pnpm-lock.yaml'), MAX_LOCK_BYTES),
    readRegularFile(join(root, 'prepared-pnpm-workspace.yaml'), MAX_MANIFEST_BYTES),
    readRegularFile(tarballPath, MAX_TARBALL_BYTES),
  ]);
  const { input } = validateReceipt(parseJson(receiptBytes, 'acceptance input'), tarballBytes);
  if (
    digest(packageBytes) !== validHash(input.stagingPackageSha256, 'staging package hash') ||
    digest(lockBytes) !== input.lockValidation.stagingLockSha256 ||
    digest(workspaceBytes) !== input.stagingWorkspaceSha256
  ) {
    fail('prepared input files do not match the acceptance receipt');
  }
  const bundlePackageBytes = await readRegularFile(
    join(bundleRoot, 'package.json'),
    MAX_MANIFEST_BYTES,
  );
  const bundleLockBytes = await readRegularFile(join(bundleRoot, 'pnpm-lock.yaml'), MAX_LOCK_BYTES);
  const bundleWorkspaceBytes = await readRegularFile(
    join(bundleRoot, 'pnpm-workspace.yaml'),
    MAX_MANIFEST_BYTES,
  );
  if (!bundleLockBytes.equals(lockBytes) || !bundleWorkspaceBytes.equals(workspaceBytes)) {
    fail('bundle lock/workspace do not match prepared inputs');
  }
  const preparedPackage = object(
    parseJson(packageBytes, 'prepared package manifest'),
    'prepared package',
  );
  const bundlePackage = object(
    parseJson(bundlePackageBytes, 'bundle package manifest'),
    'bundle package',
  );
  for (const key of [
    'name',
    'version',
    'packageManager',
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
    'bin',
    'exports',
    'type',
    'engines',
    'os',
    'cpu',
    'libc',
    'files',
    'scripts',
  ]) {
    const samePresence = Object.hasOwn(preparedPackage, key) === Object.hasOwn(bundlePackage, key);
    const sameValue =
      key === 'exports'
        ? JSON.stringify(preparedPackage[key]) === JSON.stringify(bundlePackage[key])
        : isDeepStrictEqual(preparedPackage[key], bundlePackage[key]);
    if (!samePresence || !sameValue) {
      fail(`bundle package has unexpected packed field drift: ${key}`);
    }
  }
  if (bundlePackage.dependencies?.[TUI_NAME] !== input.tui.url) {
    fail('bundle package does not bind the validated TUI artifact');
  }

  const manifestBytes = await readRegularFile(
    join(bundleRoot, 'manifest.json'),
    MAX_MANIFEST_BYTES,
  );
  const channelBytes = await readRegularFile(join(bundleRoot, 'channel.json'), MAX_MANIFEST_BYTES);
  const reportBytes = await readRegularFile(
    join(bundleRoot, 'release-bundle-report.json'),
    MAX_MANIFEST_BYTES,
  );
  const manifest = object(parseJson(manifestBytes, 'bundle manifest'), 'bundle manifest');
  const channel = object(parseJson(channelBytes, 'bundle channel'), 'bundle channel');
  const report = object(parseJson(reportBytes, 'bundle report'), 'bundle report');
  const manifestArtifacts = object(manifest.artifacts, 'bundle manifest artifacts');
  const reportArtifacts = object(report.artifacts, 'bundle report artifacts');
  const artifactEntries = /** @type {const} */ ([
    ['packageJson', bundlePackageBytes],
    ['pnpmLock', bundleLockBytes],
    ['pnpmWorkspace', bundleWorkspaceBytes],
  ]);
  for (const [key, bytes] of artifactEntries) {
    const actualHash = digest(bytes);
    if (manifestArtifacts[key]?.sha256 !== actualHash || reportArtifacts[key] !== actualHash) {
      fail(`bundle manifest/report hash mismatch: ${key}`);
    }
  }
  if (
    manifest.schemaVersion !== 'revo-install/v3' ||
    manifest.release?.version !== preparedPackage.version ||
    channel.version !== manifest.release.version ||
    report.schemaVersion !== 'revo-release-bundle/v1' ||
    report.status !== 'verified' ||
    report.release?.version !== manifest.release.version
  ) {
    fail('bundle report is not a verified release bundle');
  }
  const packageArtifact = object(manifestArtifacts.package, 'bundle package artifact');
  const packageSha256 = validHash(packageArtifact.sha256, 'bundle tarball hash');
  const packageArchiveBytes = await readRegularFile(
    join(bundleRoot, `revo-${manifest.release.version}.tgz`),
    MAX_TARBALL_BYTES,
  );
  const installerBytes = await readRegularFile(join(bundleRoot, 'install.sh'), MAX_TARBALL_BYTES);
  if (
    digest(packageArchiveBytes) !== packageSha256 ||
    digest(packageArchiveBytes) !== reportArtifacts.package ||
    integrity(packageArchiveBytes) !== packageArtifact.integrity ||
    digest(manifestBytes) !== reportArtifacts.manifest ||
    digest(channelBytes) !== reportArtifacts.channel ||
    digest(installerBytes) !== reportArtifacts.installer
  ) {
    fail('bundle artifact hashes do not match its manifest and report');
  }
  return input;
}

async function main(argv) {
  const [mode, ...args] = argv;
  if (mode === 'staging' && args.length === 2 && args.every(Boolean)) {
    const [root, tarballPath] = args;
    await verifyStagingReceipt({ root, tarballPath });
    return;
  }
  if (mode === 'handoff' && args.length === 3 && args.every(Boolean)) {
    const [root, bundleRoot, tarballPath] = args;
    await verifyHandoffReceipt({ root, bundleRoot, tarballPath });
    return;
  }
  fail('usage: preparation-receipt.mjs staging ROOT TARBALL | handoff ROOT BUNDLE TARBALL');
}

if (process.argv[1]?.endsWith('/preparation-receipt.mjs')) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  });
}
