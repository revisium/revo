import { createHash } from 'node:crypto';

import { parseReleaseMetadata } from '../release-metadata.js';
import type {
  InstallationReleaseManifest,
  PackageReleaseArtifact,
  ReleaseArtifact,
} from './metadata.types.js';

const ORIGIN = 'https://revo.revisium.io';
const PACKAGE_PREFIX = 'https://registry.npmjs.org/@revisium%2frevo/-/revo-';
const KEYS = {
  root: ['artifacts', 'components', 'release', 'schemaVersion', 'toolchain'],
  component: ['name', 'version'],
  toolchain: ['node', 'pnpm'],
  artifact: ['sha256', 'url'],
  packageArtifact: ['integrity', 'sha256', 'url'],
  artifacts: ['package', 'packageJson', 'pnpmLock', 'pnpmWorkspace'],
  components: ['admin', 'core'],
} as const;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const invalid = (reason: string): Error =>
  new Error(`Invalid Revo installation release manifest: ${reason}`);
const hash = (bytes: Uint8Array, algorithm: 'sha256' | 'sha512'): Buffer =>
  createHash(algorithm).update(bytes).digest();
const sha256 = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);

function distributionUrl(url: string, version: string, file: string): boolean {
  return url === `${ORIGIN}/releases/${version}/${file}`;
}

function packageUrl(url: string, version: string): boolean {
  return (
    url === `${PACKAGE_PREFIX}${version}.tgz` &&
    (() => {
      try {
        const parsed = new URL(url);
        return (
          parsed.origin === 'https://registry.npmjs.org' &&
          parsed.pathname === `/@revisium%2frevo/-/revo-${version}.tgz` &&
          parsed.search === '' &&
          parsed.hash === '' &&
          parsed.username === '' &&
          parsed.password === ''
        );
      } catch {
        return false;
      }
    })()
  );
}

function validateArtifact(
  value: unknown,
  expectedUrl: (url: string) => boolean,
  withIntegrity: true,
): PackageReleaseArtifact;
function validateArtifact(
  value: unknown,
  expectedUrl: (url: string) => boolean,
  withIntegrity: false,
): ReleaseArtifact;
function validateArtifact(
  value: unknown,
  expectedUrl: (url: string) => boolean,
  withIntegrity: boolean,
): ReleaseArtifact | PackageReleaseArtifact {
  const keys = withIntegrity ? KEYS.packageArtifact : KEYS.artifact;
  if (
    !record(value) ||
    !exact(value, keys) ||
    typeof value.url !== 'string' ||
    !expectedUrl(value.url) ||
    typeof value.sha256 !== 'string' ||
    !sha256(value.sha256)
  ) {
    throw invalid('artifact is invalid');
  }
  if (
    withIntegrity &&
    (typeof value.integrity !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]{86}={0,2}$/.test(value.integrity) ||
      !validIntegrityLength(value.integrity))
  ) {
    throw invalid('package integrity is invalid');
  }
  if (withIntegrity) {
    if (typeof value.integrity !== 'string') {
      throw invalid('package integrity is invalid');
    }
    return {
      url: value.url,
      sha256: value.sha256,
      integrity: value.integrity,
    };
  }
  return { url: value.url, sha256: value.sha256 };
}

function validIntegrityLength(integrity: string): boolean {
  try {
    const encoded = integrity.slice(7);
    const decoded = Buffer.from(encoded, 'base64');
    return decoded.length === 64 && decoded.toString('base64') === encoded;
  } catch {
    return false;
  }
}

export function parseInstallationReleaseManifest(
  value: unknown,
  expected?: { readonly channel?: string; readonly version?: string },
): InstallationReleaseManifest {
  if (
    !record(value) ||
    !exact(value, KEYS.root) ||
    value.schemaVersion !== 'revo-install/v1' ||
    !record(value.components) ||
    !exact(value.components, KEYS.components) ||
    !record(value.toolchain) ||
    !exact(value.toolchain, KEYS.toolchain) ||
    value.toolchain.node !== '26.8.2' ||
    value.toolchain.pnpm !== '12.4.1' ||
    !record(value.artifacts) ||
    !exact(value.artifacts, KEYS.artifacts)
  ) {
    throw invalid('schema or top-level fields are invalid');
  }
  const release = parseReleaseMetadata(value.release);
  if (expected?.channel !== undefined && release.channel !== expected.channel) {
    throw invalid('release channel does not match the requested channel');
  }
  if (expected?.version !== undefined && release.version !== expected.version) {
    throw invalid('release version does not match the requested version');
  }
  if (
    !record(value.components.core) ||
    !exact(value.components.core, KEYS.component) ||
    value.components.core.name !== '@revisium/revo-core' ||
    value.components.core.version !== '0.0.0' ||
    !record(value.components.admin) ||
    !exact(value.components.admin, KEYS.component) ||
    value.components.admin.name !== '@revisium/revo-admin' ||
    value.components.admin.version !== '0.0.0'
  ) {
    throw invalid('component pins are invalid');
  }
  const version = release.version;
  validateArtifact(value.artifacts.package, (url) => packageUrl(url, version), true);
  validateArtifact(
    value.artifacts.packageJson,
    (url) => distributionUrl(url, version, 'package.json'),
    false,
  );
  validateArtifact(
    value.artifacts.pnpmLock,
    (url) => distributionUrl(url, version, 'pnpm-lock.yaml'),
    false,
  );
  validateArtifact(
    value.artifacts.pnpmWorkspace,
    (url) => distributionUrl(url, version, 'pnpm-workspace.yaml'),
    false,
  );
  return {
    schemaVersion: 'revo-install/v1',
    release,
    components: {
      core: { name: '@revisium/revo-core', version: '0.0.0' },
      admin: { name: '@revisium/revo-admin', version: '0.0.0' },
    },
    toolchain: { node: '26.8.2', pnpm: '12.4.1' },
    artifacts: {
      package: validateArtifact(value.artifacts.package, (url) => packageUrl(url, version), true),
      packageJson: validateArtifact(
        value.artifacts.packageJson,
        (url) => distributionUrl(url, version, 'package.json'),
        false,
      ),
      pnpmLock: validateArtifact(
        value.artifacts.pnpmLock,
        (url) => distributionUrl(url, version, 'pnpm-lock.yaml'),
        false,
      ),
      pnpmWorkspace: validateArtifact(
        value.artifacts.pnpmWorkspace,
        (url) => distributionUrl(url, version, 'pnpm-workspace.yaml'),
        false,
      ),
    },
  };
}

export function validateReleaseManifestUrl(url: string, version: string): boolean {
  return distributionUrl(url, version, 'manifest.json');
}

export function validateReleaseChannelUrl(url: string, channel: 'stable' | 'alpha'): boolean {
  return url === `${ORIGIN}/channels/${channel}.json`;
}

export function verifyReleaseArtifact(
  bytes: Uint8Array,
  descriptor: ReleaseArtifact | PackageReleaseArtifact,
): boolean {
  if (!sha256(descriptor.sha256) || hash(bytes, 'sha256').toString('hex') !== descriptor.sha256) {
    throw new Error('Release artifact hash verification failed.');
  }
  if ('integrity' in descriptor) {
    if (
      !/^sha512-[A-Za-z0-9+/]{86}={0,2}$/.test(descriptor.integrity) ||
      !validIntegrityLength(descriptor.integrity)
    ) {
      throw new Error('Release artifact integrity verification failed.');
    }
    const expected = descriptor.integrity.slice(7);
    if (hash(bytes, 'sha512').toString('base64') !== expected) {
      throw new Error('Release artifact integrity verification failed.');
    }
  }
  return true;
}
