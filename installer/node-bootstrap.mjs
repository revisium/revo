// oxlint-disable curly -- self-contained installer payload keeps guarded operations compact

import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HASH = /^[a-f0-9]{64}$/u;
const VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SCHEMA = 'revo-node-bootstrap/v1';
const TARGETS = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'arm64'],
  ['linux', 'x64'],
  ['win32', 'arm64'],
  ['win32', 'x64'],
];
const archiveTargets = (node) =>
  TARGETS.map(([platform, arch]) => [
    platform,
    arch,
    platform === 'win32' ? 'zip' : node && platform === 'linux' ? 'tar.xz' : 'tar.gz',
  ]);
const NODE_TARGETS = archiveTargets(true);
const PNPM_TARGETS = archiveTargets(false);
const ARCHIVE_KEYS = ['arch', 'format', 'platform', 'sha256', 'url'];
const EXECUTION_KEYS = [
  'downloadTimeoutSeconds',
  'nodeProbeTimeoutSeconds',
  'payloadTimeoutSeconds',
  'terminationGraceSeconds',
];
const V2_KEYS = ['archives', 'execution', 'nodeVersion', 'schemaVersion', 'snapshot'];
const V3_KEYS = [...V2_KEYS, 'channel', 'pnpmArchives', 'pnpmVersion'];
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value, keys) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const fail = (message) => {
  throw new Error(`Invalid Node bootstrap data: ${message}`);
};
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const identity = (platform, arch, format) => `${platform}/${arch}/${format}`;
const pnpmUrl = (version, platform, arch, format) =>
  `https://github.com/pnpm/pnpm/releases/download/v${version}/pnpm-${platform}-${arch}.${format}`;
const nodeUrlShape = (url) => /^https:\/\/(?![^/?#]*@)[^/?#]+(?:\/[^?#]*)?$/u.test(url);

function descriptor(value, targets, label, version, canonical) {
  if (!record(value) || !exact(value, ARCHIVE_KEYS)) fail(`${label} descriptor fields`);
  if (
    typeof value.platform !== 'string' ||
    typeof value.arch !== 'string' ||
    typeof value.format !== 'string' ||
    typeof value.url !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !HASH.test(value.sha256)
  )
    fail(`${label} descriptor types`);
  if (
    !targets.some(
      ([platform, arch, format]) =>
        value.platform === platform && value.arch === arch && value.format === format,
    )
  )
    fail(`${label} target or format`);
  const expected =
    canonical.length === 1
      ? canonical(value.url)
      : value.url === canonical(version, value.platform, value.arch, value.format);
  if (!expected) fail(`${label} URL is not canonical`);
  return {
    platform: value.platform,
    arch: value.arch,
    format: value.format,
    url: value.url,
    sha256: value.sha256,
  };
}

function descriptors(value, targets, label, version, canonical) {
  if (!Array.isArray(value) || value.length !== targets.length) fail(`${label} archive set length`);
  const result = value.map((item) => descriptor(item, targets, label, version, canonical));
  const identities = result.map(({ platform, arch, format }) => identity(platform, arch, format));
  if (
    new Set(identities).size !== identities.length ||
    !targets.every((target) => identities.includes(identity(...target)))
  )
    fail(`${label} target set`);
  return result;
}

/** Purely decode the literal bootstrap; it performs no filesystem or network IO. */
export function decodeBootstrap(value, options) {
  if (
    !record(options) ||
    !exact(options, ['arch', 'nodeVersion', 'platform']) ||
    typeof options.platform !== 'string' ||
    typeof options.arch !== 'string' ||
    typeof options.nodeVersion !== 'string' ||
    !VERSION.test(options.nodeVersion)
  )
    fail('target options');
  if (
    !NODE_TARGETS.some(([platform, arch]) => platform === options.platform && arch === options.arch)
  )
    fail('unsupported target');
  if (!record(value)) fail('top-level value');
  const v3 = Object.prototype.hasOwnProperty.call(value, 'pnpmArchives');
  if (
    value.schemaVersion !== SCHEMA ||
    !exact(value, v3 ? V3_KEYS : V2_KEYS) ||
    typeof value.nodeVersion !== 'string' ||
    !VERSION.test(value.nodeVersion) ||
    value.nodeVersion !== options.nodeVersion
  )
    fail('schema or Node version');
  if (
    !record(value.execution) ||
    !exact(value.execution, EXECUTION_KEYS) ||
    !EXECUTION_KEYS.every((key) => positive(value.execution[key]))
  )
    fail('execution policy');
  if (
    !record(value.snapshot) ||
    !exact(value.snapshot, ['sha256', 'url']) ||
    typeof value.snapshot.url !== 'string' ||
    typeof value.snapshot.sha256 !== 'string' ||
    !HASH.test(value.snapshot.sha256) ||
    value.snapshot.url !== `https://nodejs.org/dist/v${value.nodeVersion}/SHASUMS256.txt`
  )
    fail('checksum snapshot');
  const nodeArchives = descriptors(
    value.archives,
    NODE_TARGETS,
    'Node',
    value.nodeVersion,
    nodeUrlShape,
  );
  const nodeArchive = nodeArchives.find(
    (archive) => archive.platform === options.platform && archive.arch === options.arch,
  );
  if (nodeArchive === undefined) fail('selected Node target');
  if (!v3) return { bootstrap: value, nodeArchive, pnpmArchive: undefined };
  if (
    (value.channel !== 'stable' && value.channel !== 'alpha') ||
    typeof value.pnpmVersion !== 'string' ||
    !VERSION.test(value.pnpmVersion)
  )
    fail('pnpm version or channel');
  const pnpmArchives = descriptors(
    value.pnpmArchives,
    PNPM_TARGETS,
    'pnpm',
    value.pnpmVersion,
    pnpmUrl,
  );
  const pnpmArchive = pnpmArchives.find(
    (archive) => archive.platform === options.platform && archive.arch === options.arch,
  );
  if (
    pnpmArchive === undefined ||
    pnpmArchive.format !== (options.platform === 'win32' ? 'zip' : 'tar.gz')
  )
    fail('selected pnpm target');
  return { bootstrap: value, nodeArchive, pnpmArchive };
}

function targetParts(target) {
  if (typeof target !== 'string') fail('target input');
  const match = /^(darwin|linux|win32)-(arm64|x64)$/u.exec(target);
  if (match?.[1] === undefined || match[2] === undefined) fail('target input');
  return { platform: match[1], arch: match[2] };
}

/** Verify the existing staged Node and write one exact, exclusive receipt. */
export async function runBootstrap({ dataPath, receiptPath, target, archiveSha256 } = {}) {
  if (
    typeof dataPath !== 'string' ||
    typeof receiptPath !== 'string' ||
    typeof target !== 'string' ||
    typeof archiveSha256 !== 'string'
  )
    throw new Error('Node bootstrap input is incomplete.');
  const parts = targetParts(target);
  const value = JSON.parse(await readFile(dataPath, 'utf8'));
  const decoded = decodeBootstrap(value, { ...parts, nodeVersion: process.versions.node });
  if (process.versions.node !== decoded.bootstrap.nodeVersion)
    throw new Error('Node bootstrap runtime version does not match the data.');
  if (decoded.nodeArchive.sha256 !== archiveSha256)
    throw new Error('Node bootstrap archive checksum does not match the data.');
  const receipt = `${JSON.stringify({ version: decoded.bootstrap.nodeVersion, target, archiveSha256 })}\n`;
  const file = await open(receiptPath, 'wx', 0o600);
  try {
    await file.writeFile(receipt, 'utf8');
  } finally {
    await file.close();
  }
  return decoded;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await runBootstrap({
    dataPath: process.argv[2],
    receiptPath: process.env.REVO_RECEIPT_PATH,
    target: process.env.REVO_NODE_TARGET,
    archiveSha256: process.env.REVO_NODE_ARCHIVE_SHA256,
  });
