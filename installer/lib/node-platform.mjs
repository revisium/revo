import { parseInstallationReleaseManifest } from './release-metadata.mjs';

const NODE_TARGETS = [
  ['linux', 'x64', 'tar.xz'],
  ['linux', 'arm64', 'tar.xz'],
  ['darwin', 'x64', 'tar.gz'],
  ['darwin', 'arm64', 'tar.gz'],
  ['win32', 'x64', 'zip'],
  ['win32', 'arm64', 'zip'],
];

const BOOTSTRAP_KEYS = ['archives', 'nodeVersion', 'snapshotSha256'];
const ARCHIVE_KEYS = ['arch', 'format', 'platform', 'sha256', 'url'];

const invalid = (reason) => new Error(`Invalid Node bootstrap contract: ${reason}`);

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value, expected) => {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
};

const expectedTarget = (platform, arch) =>
  NODE_TARGETS.find(
    ([candidatePlatform, candidateArch]) =>
      candidatePlatform === platform && candidateArch === arch,
  );

const readManifestNodeRelease = (manifest) => {
  const decoded = parseInstallationReleaseManifest(manifest);
  if (decoded.schemaVersion !== 'revo-install/v2') {
    throw invalid('Node archive manifest is not version 2');
  }
  return {
    version: decoded.toolchain.node,
    archives: decoded.toolchain.nodeArchives,
    snapshotSha256: decoded.toolchain.nodeShasums.sha256,
  };
};

export function selectNodeArchive(manifest, { platform, arch }) {
  if (expectedTarget(platform, arch) === undefined) {
    throw new Error(`Unsupported Node target: ${String(platform)} ${String(arch)}`);
  }
  const release = readManifestNodeRelease(manifest);
  const archive = release.archives.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (archive === undefined) {
    throw invalid('Node archive set is incomplete');
  }
  return { ...archive };
}

export function assertBootstrapMatchesManifest(manifest, bootstrap) {
  const release = readManifestNodeRelease(manifest);
  if (
    !isRecord(bootstrap) ||
    !hasExactKeys(bootstrap, BOOTSTRAP_KEYS) ||
    !Array.isArray(bootstrap.archives) ||
    !bootstrap.archives.every((archive) => isRecord(archive) && hasExactKeys(archive, ARCHIVE_KEYS))
  ) {
    throw invalid('embedded bootstrap is invalid');
  }
  if (
    bootstrap.nodeVersion !== release.version ||
    bootstrap.snapshotSha256 !== release.snapshotSha256
  ) {
    throw invalid('embedded bootstrap identity does not match the manifest');
  }
  const archiveIdentity = ({ platform, arch }) => `${String(platform)}/${String(arch)}`;
  const identities = bootstrap.archives.map(archiveIdentity);
  if (
    bootstrap.archives.length !== release.archives.length ||
    new Set(identities).size !== identities.length
  ) {
    throw invalid('embedded Node archive table does not match the manifest');
  }
  const matches = release.archives.every((expected) => {
    const identity = archiveIdentity(expected);
    const actual = bootstrap.archives.find((archive) => archiveIdentity(archive) === identity);
    return actual !== undefined && ARCHIVE_KEYS.every((key) => actual[key] === expected[key]);
  });
  if (!matches) {
    throw invalid('embedded Node archive table does not match the manifest');
  }
}
