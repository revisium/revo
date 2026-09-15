// oxlint-disable curly -- compact schema guards keep validation branches readable

import { parseReleaseMetadata } from '../release-metadata.js';
import type {
  NodeArchiveArchitecture,
  NodeArchivePlatform,
  PackageReleaseArtifact,
  PnpmInstallationReleaseManifest,
  ReleaseArtifact,
} from './metadata.types.js';
import { parseInstallationReleaseManifest } from './release-validation.js';

export const PACKAGE_INSTALL_PLAN_SCHEMA = 'revo-package-install/v1' as const;

export interface PackageInstallPlanRequest {
  readonly release?: {
    readonly channel: 'stable' | 'alpha';
    readonly version: string;
    readonly distTag: 'latest' | 'alpha';
  };
  readonly components?: {
    readonly core: { readonly name: string; readonly version: string };
    readonly admin: { readonly name: string; readonly version: string };
  };
  readonly target: {
    readonly platform: NodeArchivePlatform;
    readonly arch: NodeArchiveArchitecture;
  };
  readonly toolchain: { readonly node: string; readonly pnpm: string };
}
export type PackageInstallRequest = PackageInstallPlanRequest;

export interface PackageInstallPlan {
  readonly schemaVersion: typeof PACKAGE_INSTALL_PLAN_SCHEMA;
  readonly release: PnpmInstallationReleaseManifest['release'];
  readonly components: PnpmInstallationReleaseManifest['components'];
  readonly artifacts: {
    readonly package: PackageReleaseArtifact;
    readonly packageJson: ReleaseArtifact;
    readonly pnpmLock: ReleaseArtifact;
    readonly pnpmWorkspace: ReleaseArtifact;
  };
  readonly target: {
    readonly platform: NodeArchivePlatform;
    readonly arch: NodeArchiveArchitecture;
  };
  readonly toolchain: { readonly node: string; readonly pnpm: string };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const invalid = (reason: string): Error =>
  new Error(`Invalid Revo package install plan: ${reason}`);

function requestShape(value: unknown): asserts value is PackageInstallPlanRequest {
  if (
    !record(value) ||
    !exact(value, [
      'target',
      'toolchain',
      ...(value.components === undefined ? [] : ['components']),
      ...(value.release === undefined ? [] : ['release']),
    ])
  ) {
    throw invalid('request fields are invalid');
  }
  if (!record(value.target) || !exact(value.target, ['arch', 'platform']))
    throw invalid('target is invalid');
  if (
    !['darwin', 'linux', 'win32'].includes(String(value.target.platform)) ||
    !['arm64', 'x64'].includes(String(value.target.arch))
  )
    throw invalid('target is invalid');
  if (
    !record(value.toolchain) ||
    !exact(value.toolchain, ['node', 'pnpm']) ||
    typeof value.toolchain.node !== 'string' ||
    typeof value.toolchain.pnpm !== 'string'
  )
    throw invalid('toolchain is invalid');
  if (value.release !== undefined) {
    if (
      !record(value.release) ||
      !exact(value.release, ['channel', 'distTag', 'version']) ||
      typeof value.release.distTag !== 'string' ||
      typeof value.release.version !== 'string'
    )
      throw invalid('release is invalid');
    try {
      parseReleaseMetadata({
        schemaVersion: 1,
        channel: value.release.channel,
        version: value.release.version,
        npm: { name: '@revisium/revo', distTag: value.release.distTag },
      });
    } catch {
      throw invalid('release is invalid');
    }
  }
  if (
    value.components !== undefined &&
    (!record(value.components) ||
      !exact(value.components, ['admin', 'core']) ||
      !record(value.components.core) ||
      !record(value.components.admin) ||
      !exact(value.components.core, ['name', 'version']) ||
      !exact(value.components.admin, ['name', 'version']) ||
      typeof value.components.core.name !== 'string' ||
      typeof value.components.core.version !== 'string' ||
      typeof value.components.admin.name !== 'string' ||
      typeof value.components.admin.version !== 'string')
  )
    throw invalid('components are invalid');
}

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const copyArtifact = <T extends ReleaseArtifact>(artifact: T): T => ({ ...artifact });

export function createPackageInstallPlan(
  input: unknown,
  requestInput?: PackageInstallPlanRequest,
): PackageInstallPlan {
  const source =
    record(input) && 'manifest' in input && 'request' in input
      ? input
      : { manifest: input, request: requestInput };
  const manifest = parseInstallationReleaseManifest(source.manifest);
  if (manifest.schemaVersion !== 'revo-install/v3')
    throw invalid('only v3 manifests are supported');
  requestShape(source.request);
  const request = source.request;
  if (
    request.release !== undefined &&
    (request.release.channel !== manifest.release.channel ||
      request.release.version !== manifest.release.version ||
      request.release.distTag !== manifest.release.npm.distTag)
  )
    throw invalid('request release does not match manifest');
  if (request.components !== undefined && !same(request.components, manifest.components))
    throw invalid('request components do not match manifest');
  if (
    request.toolchain.node !== manifest.toolchain.node ||
    request.toolchain.pnpm !== manifest.toolchain.pnpm
  )
    throw invalid('request toolchain does not match manifest');
  const artifacts = manifest.artifacts;
  return {
    schemaVersion: PACKAGE_INSTALL_PLAN_SCHEMA,
    release: { ...manifest.release, npm: { ...manifest.release.npm } },
    components: { core: { ...manifest.components.core }, admin: { ...manifest.components.admin } },
    artifacts: {
      package: copyArtifact(artifacts.package),
      packageJson: copyArtifact(artifacts.packageJson),
      pnpmLock: copyArtifact(artifacts.pnpmLock),
      pnpmWorkspace: copyArtifact(artifacts.pnpmWorkspace),
    },
    target: { ...request.target },
    toolchain: { node: manifest.toolchain.node, pnpm: manifest.toolchain.pnpm },
  };
}

export const buildPackageInstallPlan = createPackageInstallPlan;
export const packageInstallPlan = createPackageInstallPlan;

export function parsePackageInstallPlan(value: unknown): PackageInstallPlan {
  if (
    !record(value) ||
    !exact(value, ['artifacts', 'components', 'release', 'schemaVersion', 'target', 'toolchain']) ||
    value.schemaVersion !== PACKAGE_INSTALL_PLAN_SCHEMA
  )
    throw invalid('schema or fields are invalid');
  if (
    !record(value.target) ||
    !exact(value.target, ['arch', 'platform']) ||
    !record(value.toolchain) ||
    !exact(value.toolchain, ['node', 'pnpm'])
  )
    throw invalid('target or toolchain is invalid');
  const request = { target: value.target, toolchain: value.toolchain };
  requestShape(request);
  const plan = createPackageInstallPlan({
    manifest: {
      schemaVersion: 'revo-install/v3',
      release: value.release,
      components: value.components,
      artifacts: value.artifacts,
      toolchain: {
        node: request.toolchain.node,
        pnpm: request.toolchain.pnpm,
        nodeArchives: (
          [
            ['linux', 'x64', 'tar.xz'],
            ['linux', 'arm64', 'tar.xz'],
            ['darwin', 'x64', 'tar.gz'],
            ['darwin', 'arm64', 'tar.gz'],
            ['win32', 'x64', 'zip'],
            ['win32', 'arm64', 'zip'],
          ] as const
        ).map(([platform, arch, format]) => ({
          platform,
          arch,
          format,
          url: 'https://invalid.example/node',
          sha256: '0'.repeat(64),
        })),
        nodeShasums: { url: 'https://invalid.example/unused', sha256: '0'.repeat(64) },
        pnpmArchives: (
          [
            ['darwin', 'arm64', 'tar.gz'],
            ['darwin', 'x64', 'tar.gz'],
            ['linux', 'arm64', 'tar.gz'],
            ['linux', 'x64', 'tar.gz'],
            ['win32', 'arm64', 'zip'],
            ['win32', 'x64', 'zip'],
          ] as const
        ).map(([platform, arch, format]) => ({
          platform,
          arch,
          format,
          url: 'https://invalid.example/pnpm',
          sha256: '0'.repeat(64),
        })),
      },
    },
    request,
  });
  return plan;
}
