import { createHash } from 'node:crypto';

import type { InstallationReleaseManifest } from '../../../src/installation/metadata.types.js';
import type { InstallationReleasePolicy } from '../../../src/installation/release-policy.js';
import type { ReleaseMetadata } from '../../../src/release-metadata.js';

export interface ReleasePolicyFixtureOptions {
  readonly distributionRoot?: string;
  readonly registryRoot?: string;
  readonly packageName?: string;
  readonly supportedSchemaVersions?: readonly string[];
  readonly requested?: InstallationReleasePolicy['requested'];
}

export interface ReleaseManifestFixtureOptions {
  readonly channel?: ReleaseMetadata['channel'];
  readonly version?: string;
  readonly versions?: {
    readonly core: string;
    readonly admin: string;
    readonly node: string;
    readonly pnpm: string;
  };
  readonly policy?: InstallationReleasePolicy;
}

export interface ReleaseManifestFixture {
  readonly manifest: InstallationReleaseManifest;
  readonly policy: InstallationReleasePolicy;
  readonly bytes: {
    readonly package: Uint8Array;
    readonly packageJson: Uint8Array;
    readonly pnpmLock: Uint8Array;
    readonly pnpmWorkspace: Uint8Array;
  };
}

const DEFAULT_DISTRIBUTION_ROOT = 'https://revo.revisium.io';
const DEFAULT_REGISTRY_ROOT = 'https://registry.npmjs.org';
const DEFAULT_PACKAGE_NAME = '@revisium/revo';
const DEFAULT_SCHEMA_VERSION = 'revo-install/v1';

const digest = (bytes: Uint8Array, algorithm: 'sha256' | 'sha512'): string =>
  createHash(algorithm).update(bytes).digest('hex');

// The only policy used by the tests: every locator is spelled out here so that
// manifests and expectations cannot drift onto separate URL shapes.
export function releasePolicyFixture(
  options: ReleasePolicyFixtureOptions = {},
): InstallationReleasePolicy {
  const distributionRoot = options.distributionRoot ?? DEFAULT_DISTRIBUTION_ROOT;
  const registryRoot = options.registryRoot ?? DEFAULT_REGISTRY_ROOT;
  const packageName = options.packageName ?? DEFAULT_PACKAGE_NAME;
  const tarballName = packageName.slice(packageName.indexOf('/') + 1);
  const packageRoot = `${registryRoot}/${packageName.replace('/', '%2f')}/-`;
  const releaseRoot = (version: string): string => `${distributionRoot}/releases/${version}`;
  return {
    supportedSchemaVersions: options.supportedSchemaVersions ?? [DEFAULT_SCHEMA_VERSION],
    ...(options.requested === undefined ? {} : { requested: options.requested }),
    locators: {
      artifacts: {
        package: (release) => `${packageRoot}/${tarballName}-${release.version}.tgz`,
        packageJson: (release) => `${releaseRoot(release.version)}/package.json`,
        pnpmLock: (release) => `${releaseRoot(release.version)}/pnpm-lock.yaml`,
        pnpmWorkspace: (release) => `${releaseRoot(release.version)}/pnpm-workspace.yaml`,
      },
      manifest: (version) => `${releaseRoot(version)}/manifest.json`,
      channel: (channel) => `${distributionRoot}/channels/${channel}.json`,
    },
  };
}

export function releaseManifestFixture(
  options: ReleaseManifestFixtureOptions = {},
): ReleaseManifestFixture {
  const channel = options.channel ?? 'stable';
  const version = options.version ?? (channel === 'stable' ? '1.2.3' : '1.2.3-alpha.1');
  const versions = options.versions ?? {
    core: '0.0.0',
    admin: '0.0.0',
    node: '26.8.2',
    pnpm: '12.4.1',
  };
  const policy = options.policy ?? releasePolicyFixture();
  const bytes = {
    package: Buffer.from('synthetic revo package bytes'),
    packageJson: Buffer.from('{"name":"@revisium/revo","version":"1.2.3"}'),
    pnpmLock: Buffer.from('lockfileVersion: 9.0\n'),
    pnpmWorkspace: Buffer.from('packages:\n  - .\n'),
  };
  const release: ReleaseMetadata = {
    schemaVersion: 1,
    channel,
    version,
    npm: { name: '@revisium/revo', distTag: channel === 'stable' ? 'latest' : 'alpha' },
  };
  const locators = policy.locators.artifacts;
  return {
    bytes,
    policy,
    manifest: {
      schemaVersion: DEFAULT_SCHEMA_VERSION,
      release,
      components: {
        core: { name: '@revisium/revo-core', version: versions.core },
        admin: { name: '@revisium/revo-admin', version: versions.admin },
      },
      toolchain: { node: versions.node, pnpm: versions.pnpm },
      artifacts: {
        package: {
          url: locators.package(release),
          sha256: digest(bytes.package, 'sha256'),
          integrity: `sha512-${createHash('sha512').update(bytes.package).digest('base64')}`,
        },
        packageJson: {
          url: locators.packageJson(release),
          sha256: digest(bytes.packageJson, 'sha256'),
        },
        pnpmLock: { url: locators.pnpmLock(release), sha256: digest(bytes.pnpmLock, 'sha256') },
        pnpmWorkspace: {
          url: locators.pnpmWorkspace(release),
          sha256: digest(bytes.pnpmWorkspace, 'sha256'),
        },
      },
    },
  };
}
