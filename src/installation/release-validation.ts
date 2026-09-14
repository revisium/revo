import { isSemVerString, parseReleaseMetadata } from '../release-metadata.js';
import type {
  InstallationReleaseManifest,
  PackageReleaseArtifact,
  ReleaseArtifact,
} from './metadata.types.js';

const KEYS = {
  root: ['artifacts', 'components', 'release', 'schemaVersion', 'toolchain'],
  component: ['name', 'version'],
  toolchain: ['node', 'pnpm'],
  artifact: ['sha256', 'url'],
  packageArtifact: ['integrity', 'sha256', 'url'],
  artifacts: ['package', 'packageJson', 'pnpmLock', 'pnpmWorkspace'],
  components: ['admin', 'core'],
} as const;

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const SRI_SHA512_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/;
const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NPM_PACKAGE_NAME_MAX_LENGTH = 214;

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

export function parseInstallationReleaseManifest(value: unknown): InstallationReleaseManifest {
  if (
    !record(value) ||
    !exact(value, KEYS.root) ||
    typeof value.schemaVersion !== 'string' ||
    !record(value.components) ||
    !exact(value.components, KEYS.components) ||
    !record(value.toolchain) ||
    !exact(value.toolchain, KEYS.toolchain) ||
    typeof value.toolchain.node !== 'string' ||
    !isSemVerString(value.toolchain.node) ||
    typeof value.toolchain.pnpm !== 'string' ||
    !isSemVerString(value.toolchain.pnpm) ||
    !record(value.artifacts) ||
    !exact(value.artifacts, KEYS.artifacts)
  ) {
    throw invalid('schema or top-level fields are invalid');
  }
  const release = parseReleaseMetadata(value.release);
  const core = parseComponent(value.components.core);
  const admin = parseComponent(value.components.admin);
  return {
    schemaVersion: value.schemaVersion,
    release,
    components: { core, admin },
    toolchain: { node: value.toolchain.node, pnpm: value.toolchain.pnpm },
    artifacts: {
      package: parseArtifact(value.artifacts.package, true),
      packageJson: parseArtifact(value.artifacts.packageJson, false),
      pnpmLock: parseArtifact(value.artifacts.pnpmLock, false),
      pnpmWorkspace: parseArtifact(value.artifacts.pnpmWorkspace, false),
    },
  };
}
