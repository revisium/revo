import { isSemVerString, parseReleaseMetadata } from '../release-metadata.js';
import type {
  InstallationReleaseManifest,
  LegacyReleaseToolchain,
  NodeArchiveArchitecture,
  NodeArchiveFormat,
  NodeArchivePlatform,
  NodeArchiveReleaseArtifact,
  NodeReleaseToolchain,
  PnpmArchiveArchitecture,
  PnpmArchiveFormat,
  PnpmArchivePlatform,
  PnpmArchiveReleaseArtifact,
  PnpmReleaseToolchain,
  PackageReleaseArtifact,
  ReleaseArtifact,
  UnknownInstallationSchemaVersion,
} from './metadata.types.js';

const KEYS = {
  root: ['artifacts', 'components', 'release', 'schemaVersion', 'toolchain'],
  component: ['name', 'version'],
  toolchain: ['node', 'pnpm'],
  nodeToolchain: ['node', 'nodeArchives', 'nodeShasums', 'pnpm'],
  nodeArchive: ['arch', 'format', 'platform', 'sha256', 'url'],
  pnpmToolchain: ['node', 'nodeArchives', 'nodeShasums', 'pnpm', 'pnpmArchives'],
  pnpmArchive: ['arch', 'format', 'platform', 'sha256', 'url'],
  artifact: ['sha256', 'url'],
  packageArtifact: ['integrity', 'sha256', 'url'],
  artifacts: ['package', 'packageJson', 'pnpmLock', 'pnpmWorkspace'],
  components: ['admin', 'core'],
} as const;

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const SRI_SHA512_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/;
const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NPM_PACKAGE_NAME_MAX_LENGTH = 214;

const NODE_ARCHIVE_TARGETS = [
  ['linux', 'x64', 'tar.xz'],
  ['linux', 'arm64', 'tar.xz'],
  ['darwin', 'x64', 'tar.gz'],
  ['darwin', 'arm64', 'tar.gz'],
  ['win32', 'x64', 'zip'],
  ['win32', 'arm64', 'zip'],
] as const satisfies ReadonlyArray<
  readonly [NodeArchivePlatform, NodeArchiveArchitecture, NodeArchiveFormat]
>;

const PNPM_ARCHIVE_TARGETS = [
  ['darwin', 'arm64', 'tar.gz'],
  ['darwin', 'x64', 'tar.gz'],
  ['linux', 'arm64', 'tar.gz'],
  ['linux', 'x64', 'tar.gz'],
  ['win32', 'arm64', 'zip'],
  ['win32', 'x64', 'zip'],
] as const satisfies ReadonlyArray<
  readonly [PnpmArchivePlatform, PnpmArchiveArchitecture, PnpmArchiveFormat]
>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const invalid = (reason: string): Error =>
  new Error(`Invalid Revo installation release manifest: ${reason}`);

function isUnknownInstallationSchemaVersion(
  value: unknown,
): value is UnknownInstallationSchemaVersion {
  return typeof value === 'string' && value !== 'revo-install/v1' && value !== 'revo-install/v2';
}

function isSha256HexString(value: string): boolean {
  return SHA256_HEX_PATTERN.test(value);
}

function isSha512SriString(value: string): boolean {
  if (!SRI_SHA512_PATTERN.test(value)) {
    return false;
  }
  const encoded = value.slice('sha512-'.length);
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.length === 64 && decoded.toString('base64') === encoded;
}

function isNpmPackageNameString(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= NPM_PACKAGE_NAME_MAX_LENGTH &&
    NPM_PACKAGE_NAME_PATTERN.test(value)
  );
}

function parseComponent(value: unknown): { name: string; version: string } {
  if (
    !record(value) ||
    !exact(value, KEYS.component) ||
    typeof value.name !== 'string' ||
    !isNpmPackageNameString(value.name) ||
    typeof value.version !== 'string' ||
    !isSemVerString(value.version)
  ) {
    throw invalid('component pins are invalid');
  }
  return { name: value.name, version: value.version };
}

function parseArtifact(value: unknown, withIntegrity: true): PackageReleaseArtifact;
function parseArtifact(value: unknown, withIntegrity: false): ReleaseArtifact;
function parseArtifact(
  value: unknown,
  withIntegrity: boolean,
): ReleaseArtifact | PackageReleaseArtifact {
  const keys = withIntegrity ? KEYS.packageArtifact : KEYS.artifact;
  if (
    !record(value) ||
    !exact(value, keys) ||
    typeof value.url !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !isSha256HexString(value.sha256)
  ) {
    throw invalid('artifact is invalid');
  }
  if (withIntegrity) {
    if (typeof value.integrity !== 'string' || !isSha512SriString(value.integrity)) {
      throw invalid('package integrity is invalid');
    }
    return { url: value.url, sha256: value.sha256, integrity: value.integrity };
  }
  return { url: value.url, sha256: value.sha256 };
}

function parseNodeArchive(value: unknown): NodeArchiveReleaseArtifact {
  const target = record(value)
    ? NODE_ARCHIVE_TARGETS.find(
        ([platform, arch, format]) =>
          value.platform === platform && value.arch === arch && value.format === format,
      )
    : undefined;
  if (
    !record(value) ||
    !exact(value, KEYS.nodeArchive) ||
    target === undefined ||
    typeof value.url !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !isSha256HexString(value.sha256)
  ) {
    throw invalid('Node archive is invalid');
  }
  const [platform, arch, format] = target;
  return {
    platform,
    arch,
    format,
    url: value.url,
    sha256: value.sha256,
  };
}

function parsePnpmArchive(value: unknown): PnpmArchiveReleaseArtifact {
  const target = record(value)
    ? PNPM_ARCHIVE_TARGETS.find(
        ([platform, arch, format]) =>
          value.platform === platform && value.arch === arch && value.format === format,
      )
    : undefined;
  if (
    !record(value) ||
    !exact(value, KEYS.pnpmArchive) ||
    target === undefined ||
    typeof value.url !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !isSha256HexString(value.sha256)
  ) {
    throw invalid('pnpm archive is invalid');
  }
  const [platform, arch, format] = target;
  return { platform, arch, format, url: value.url, sha256: value.sha256 };
}

function parseToolchainVersion(value: Record<string, unknown>): {
  node: string;
  pnpm: string;
} {
  if (
    typeof value.node !== 'string' ||
    !isSemVerString(value.node) ||
    typeof value.pnpm !== 'string' ||
    !isSemVerString(value.pnpm)
  ) {
    throw invalid('schema or top-level fields are invalid');
  }
  return { node: value.node, pnpm: value.pnpm };
}

function parseLegacyToolchain(value: Record<string, unknown>): LegacyReleaseToolchain {
  const version = parseToolchainVersion(value);
  if (!exact(value, KEYS.toolchain)) {
    throw invalid('schema or top-level fields are invalid');
  }
  return version;
}

function parseNodeToolchain(value: Record<string, unknown>): NodeReleaseToolchain {
  const version = parseToolchainVersion(value);
  if (!exact(value, KEYS.nodeToolchain) || !Array.isArray(value.nodeArchives)) {
    throw invalid('schema or top-level fields are invalid');
  }
  const nodeArchives = value.nodeArchives.map(parseNodeArchive);
  const targets = nodeArchives.map(({ platform, arch, format }) => `${platform}/${arch}/${format}`);
  const expectedTargets = NODE_ARCHIVE_TARGETS.map((target) => target.join('/'));
  if (
    targets.length !== expectedTargets.length ||
    new Set(targets).size !== targets.length ||
    !expectedTargets.every((target) => targets.includes(target))
  ) {
    throw invalid('Node archive set is incomplete');
  }
  return {
    ...version,
    nodeArchives,
    nodeShasums: parseArtifact(value.nodeShasums, false),
  };
}

function parsePnpmToolchain(value: Record<string, unknown>): PnpmReleaseToolchain {
  const version = parseToolchainVersion(value);
  if (
    !exact(value, KEYS.pnpmToolchain) ||
    !Array.isArray(value.nodeArchives) ||
    !Array.isArray(value.pnpmArchives)
  ) {
    throw invalid('schema or top-level fields are invalid');
  }
  const nodeArchives = value.nodeArchives.map(parseNodeArchive);
  const nodeTargets = nodeArchives.map(
    ({ platform, arch, format }) => `${platform}/${arch}/${format}`,
  );
  const expectedNodeTargets = NODE_ARCHIVE_TARGETS.map((target) => target.join('/'));
  if (
    nodeTargets.length !== expectedNodeTargets.length ||
    new Set(nodeTargets).size !== nodeTargets.length ||
    !expectedNodeTargets.every((target) => nodeTargets.includes(target))
  ) {
    throw invalid('Node archive set is incomplete');
  }
  const pnpmArchives = value.pnpmArchives.map(parsePnpmArchive);
  const targets = pnpmArchives.map(({ platform, arch, format }) => `${platform}/${arch}/${format}`);
  const expectedTargets = PNPM_ARCHIVE_TARGETS.map((target) => target.join('/'));
  if (
    targets.length !== expectedTargets.length ||
    new Set(targets).size !== targets.length ||
    !expectedTargets.every((target) => targets.includes(target))
  ) {
    throw invalid('pnpm archive set is incomplete');
  }
  return {
    ...version,
    nodeArchives,
    nodeShasums: parseArtifact(value.nodeShasums, false),
    pnpmArchives,
  };
}

export function parseInstallationReleaseManifest(value: unknown): InstallationReleaseManifest {
  if (
    !record(value) ||
    !exact(value, KEYS.root) ||
    typeof value.schemaVersion !== 'string' ||
    !record(value.components) ||
    !exact(value.components, KEYS.components) ||
    !record(value.toolchain) ||
    !record(value.artifacts) ||
    !exact(value.artifacts, KEYS.artifacts)
  ) {
    throw invalid('schema or top-level fields are invalid');
  }
  const release = parseReleaseMetadata(value.release);
  const core = parseComponent(value.components.core);
  const admin = parseComponent(value.components.admin);
  const fields = {
    release,
    components: { core, admin },
    artifacts: {
      package: parseArtifact(value.artifacts.package, true),
      packageJson: parseArtifact(value.artifacts.packageJson, false),
      pnpmLock: parseArtifact(value.artifacts.pnpmLock, false),
      pnpmWorkspace: parseArtifact(value.artifacts.pnpmWorkspace, false),
    },
  };
  if (value.schemaVersion === 'revo-install/v3') {
    return {
      ...fields,
      schemaVersion: value.schemaVersion,
      toolchain: parsePnpmToolchain(value.toolchain),
    };
  }
  if (value.schemaVersion === 'revo-install/v2') {
    return {
      ...fields,
      schemaVersion: value.schemaVersion,
      toolchain: parseNodeToolchain(value.toolchain),
    };
  }
  if (value.schemaVersion === 'revo-install/v1') {
    return {
      ...fields,
      schemaVersion: value.schemaVersion,
      toolchain: parseLegacyToolchain(value.toolchain),
    };
  }
  if (isUnknownInstallationSchemaVersion(value.schemaVersion)) {
    return {
      ...fields,
      schemaVersion: value.schemaVersion,
      toolchain: parseLegacyToolchain(value.toolchain),
    };
  }
  throw invalid('schema or top-level fields are invalid');
}
