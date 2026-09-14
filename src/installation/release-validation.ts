import { isSemVerString, parseReleaseMetadata } from '../release-metadata.js';
import type {
  InstallationReleaseManifest,
  NodeArchiveArchitecture,
  NodeArchiveFormat,
  NodeArchivePlatform,
  NodeArchiveReleaseArtifact,
  PackageReleaseArtifact,
  ReleaseArtifact,
} from './metadata.types.js';

const KEYS = {
  root: ['artifacts', 'components', 'release', 'schemaVersion', 'toolchain'],
  component: ['name', 'version'],
  toolchain: ['node', 'pnpm'],
  nodeToolchain: ['node', 'nodeArchives', 'nodeShasums', 'pnpm'],
  nodeArchive: ['arch', 'format', 'platform', 'sha256', 'url'],
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

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const invalid = (reason: string): Error =>
  new Error(`Invalid Revo installation release manifest: ${reason}`);

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

function parseToolchain(value: Record<string, unknown>): InstallationReleaseManifest['toolchain'] {
  if (
    typeof value.node !== 'string' ||
    !isSemVerString(value.node) ||
    typeof value.pnpm !== 'string' ||
    !isSemVerString(value.pnpm)
  ) {
    throw invalid('schema or top-level fields are invalid');
  }
  if (exact(value, KEYS.toolchain)) {
    return { node: value.node, pnpm: value.pnpm };
  }
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
    node: value.node,
    pnpm: value.pnpm,
    nodeArchives,
    nodeShasums: parseArtifact(value.nodeShasums, false),
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
  const toolchain = parseToolchain(value.toolchain);
  return {
    schemaVersion: value.schemaVersion,
    release,
    components: { core, admin },
    toolchain,
    artifacts: {
      package: parseArtifact(value.artifacts.package, true),
      packageJson: parseArtifact(value.artifacts.packageJson, false),
      pnpmLock: parseArtifact(value.artifacts.pnpmLock, false),
      pnpmWorkspace: parseArtifact(value.artifacts.pnpmWorkspace, false),
    },
  };
}
