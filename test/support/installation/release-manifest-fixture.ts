import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type {
  InstallationReleaseManifest,
  NodeInstallationReleaseManifest,
  PnpmArchiveArchitecture,
  PnpmArchiveFormat,
  PnpmArchivePlatform,
  PnpmInstallationReleaseManifest,
} from '../../../src/installation/metadata.types.js';
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

export interface FutureReleasePolicy extends InstallationReleasePolicy {
  readonly locators: InstallationReleasePolicy['locators'] & {
    readonly nodeArchive: (
      version: string,
      platform: NodeArchivePlatform,
      arch: NodeArchiveArchitecture,
      format: NodeArchiveFormat,
    ) => string;
    readonly nodeShasums: (version: string) => string;
    readonly pnpmArchive: (
      version: string,
      platform: PnpmArchivePlatform,
      arch: PnpmArchiveArchitecture,
      format: PnpmArchiveFormat,
    ) => string;
  };
}

export interface FutureReleaseManifestFixtureOptions extends Omit<
  ReleaseManifestFixtureOptions,
  'policy'
> {
  readonly policy?: FutureReleasePolicy;
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

export type NodeArchivePlatform = 'darwin' | 'linux' | 'win32';
export type NodeArchiveArchitecture = 'arm64' | 'x64';
export type NodeArchiveFormat = 'tar.gz' | 'tar.xz' | 'zip';

export interface NodeArchiveFixture {
  readonly platform: NodeArchivePlatform;
  readonly arch: NodeArchiveArchitecture;
  readonly format: NodeArchiveFormat;
  readonly url: string;
  readonly sha256: string;
}

export interface PnpmArchiveFixture {
  readonly platform: PnpmArchivePlatform;
  readonly arch: PnpmArchiveArchitecture;
  readonly format: PnpmArchiveFormat;
  readonly url: string;
  readonly sha256: string;
}

export interface FutureReleaseManifestFixture extends Omit<ReleaseManifestFixture, 'manifest'> {
  readonly manifest: NodeInstallationReleaseManifest & {
    readonly schemaVersion: 'revo-install/v2';
    readonly toolchain: NodeInstallationReleaseManifest['toolchain'] & {
      readonly nodeArchives: readonly NodeArchiveFixture[];
      readonly nodeShasums: { readonly url: string; readonly sha256: string };
    };
  };
}

export interface PnpmReleaseManifestFixture extends Omit<ReleaseManifestFixture, 'manifest'> {
  readonly policy: FutureReleasePolicy;
  readonly manifest: PnpmInstallationReleaseManifest & {
    readonly schemaVersion: 'revo-install/v3';
    readonly toolchain: PnpmInstallationReleaseManifest['toolchain'] & {
      readonly nodeArchives: readonly NodeArchiveFixture[];
      readonly nodeShasums: { readonly url: string; readonly sha256: string };
      readonly pnpmArchives: readonly PnpmArchiveFixture[];
    };
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

export function futureReleasePolicyFixture(
  options: ReleasePolicyFixtureOptions = {},
): FutureReleasePolicy {
  const policy = releasePolicyFixture(options);
  const nodeRoot = (version: string): string => `https://nodejs.org/dist/v${version}`;
  return {
    ...policy,
    locators: {
      ...policy.locators,
      nodeArchive: (version, platform, arch, format) =>
        `${nodeRoot(version)}/node-v${version}-${platform === 'win32' ? 'win' : platform}-${arch}.${format}`,
      nodeShasums: (version) => `${nodeRoot(version)}/SHASUMS256.txt`,
      pnpmArchive: (version, platform, arch, format) =>
        `https://github.com/pnpm/pnpm/releases/download/v${version}/pnpm-${platform}-${arch}.${format}`,
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
    pnpm: '12.5.1',
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

const NODE_26_8_2_ARCHIVES = [
  ['linux', 'x64', 'tar.xz', '40e1d3225c1c9ae9a2671c98ecb9857e4d5555026394f348645676798840d5c5'],
  ['linux', 'arm64', 'tar.xz', '81d8f0fdea9dcd3bfdcfeafc5f8359c151f097e9880b0007c0645ca670d07971'],
  ['darwin', 'x64', 'tar.gz', 'adb8feb2d4987df3d72d2ec46f4fc4b58039c859b8c3f0e3cc2d3c6cbaf8629c'],
  ['darwin', 'arm64', 'tar.gz', '974b6d5fb2fc7c33ff2354db0902b4e91c2de01ec8acc6de48e543c97e18c9e1'],
  ['win32', 'x64', 'zip', 'cf02f5d0c06c794b84f277177d5cf3743d0924ca49f6641cd435dd7cb6ee9085'],
  ['win32', 'arm64', 'zip', 'a4e8362e268f1fcf1735f046e0adb088b28eeb400fb1c33fe5cc94d1a3d42570'],
] as const;

interface PnpmAssetFixture {
  readonly version: string;
  readonly archives: readonly {
    readonly platform: PnpmArchivePlatform;
    readonly arch: PnpmArchiveArchitecture;
    readonly format: PnpmArchiveFormat;
    readonly sha256: string;
  }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPnpmAssetFixture = (value: unknown): value is PnpmAssetFixture =>
  isRecord(value) &&
  typeof value.version === 'string' &&
  Array.isArray(value.archives) &&
  value.archives.every(
    (archive) =>
      isRecord(archive) &&
      typeof archive.platform === 'string' &&
      typeof archive.arch === 'string' &&
      typeof archive.format === 'string' &&
      typeof archive.sha256 === 'string',
  );

const readPnpmAssetFixture = (): PnpmAssetFixture => {
  const value: unknown = JSON.parse(
    readFileSync(
      new URL('../../fixtures/installation/pnpm-v12.5.1-assets.json', import.meta.url),
      'utf8',
    ),
  );
  if (!isPnpmAssetFixture(value)) {
    throw new Error('pnpm asset fixture is invalid');
  }
  return value;
};

const PNPM_ASSET_FIXTURE = readPnpmAssetFixture();

export function futureReleaseManifestFixture(
  options: FutureReleaseManifestFixtureOptions = {},
): FutureReleaseManifestFixture {
  const policy = options.policy ?? futureReleasePolicyFixture();
  const fixture = releaseManifestFixture({ ...options, policy });
  const nodeVersion = fixture.manifest.toolchain.node;
  const snapshotSha256 =
    nodeVersion === '26.8.2'
      ? 'c31cbd53707d1e82ed2094d4554eb13562a8be9521433f8bc4447776a7e7dad3'
      : digest(Buffer.from(`synthetic Node ${nodeVersion} checksum snapshot`), 'sha256');
  const nodeArchives = NODE_26_8_2_ARCHIVES.map(([platform, arch, format, sha256]) => ({
    platform,
    arch,
    format,
    url: policy.locators.nodeArchive(nodeVersion, platform, arch, format),
    sha256:
      nodeVersion === '26.8.2'
        ? sha256
        : digest(Buffer.from(`synthetic ${nodeVersion} ${platform} ${arch} ${format}`), 'sha256'),
  }));
  return {
    ...fixture,
    manifest: {
      ...fixture.manifest,
      schemaVersion: 'revo-install/v2',
      toolchain: {
        ...fixture.manifest.toolchain,
        nodeArchives,
        nodeShasums: {
          url: policy.locators.nodeShasums(nodeVersion),
          sha256: snapshotSha256,
        },
      },
    },
  };
}

export function pnpmReleasePolicyFixture(
  options: ReleasePolicyFixtureOptions = {},
): FutureReleasePolicy {
  return futureReleasePolicyFixture({
    ...options,
    supportedSchemaVersions: options.supportedSchemaVersions ?? ['revo-install/v3'],
  });
}

export function pnpmReleaseManifestFixture(
  options: Omit<ReleaseManifestFixtureOptions, 'policy'> & {
    readonly policy?: FutureReleasePolicy;
  } = {},
): PnpmReleaseManifestFixture {
  const policy = options.policy ?? pnpmReleasePolicyFixture();
  const fixture = futureReleaseManifestFixture({ ...options, policy });
  const pnpmVersion = fixture.manifest.toolchain.pnpm;
  const pnpmArchives =
    pnpmVersion === PNPM_ASSET_FIXTURE.version
      ? PNPM_ASSET_FIXTURE.archives.map((archive) => ({
          ...archive,
          url: policy.locators.pnpmArchive(
            pnpmVersion,
            archive.platform,
            archive.arch,
            archive.format,
          ),
        }))
      : (['darwin', 'linux', 'win32'] as const).flatMap((platform) =>
          (['arm64', 'x64'] as const).map((arch) => {
            const format: PnpmArchiveFormat = platform === 'win32' ? 'zip' : 'tar.gz';
            return {
              platform,
              arch,
              format,
              url: policy.locators.pnpmArchive(pnpmVersion, platform, arch, format),
              sha256: digest(
                Buffer.from(`synthetic pnpm ${pnpmVersion} ${platform} ${arch} ${format}`),
                'sha256',
              ),
            };
          }),
        );
  return {
    ...fixture,
    policy,
    manifest: {
      ...fixture.manifest,
      schemaVersion: 'revo-install/v3',
      toolchain: { ...fixture.manifest.toolchain, pnpmArchives },
    },
  };
}
