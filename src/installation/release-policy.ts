import type { ReleaseMetadata } from '../release-metadata.js';
import type {
  InstallationReleaseManifest,
  NodeArchiveArchitecture,
  NodeArchiveFormat,
  NodeArchivePlatform,
  NodeReleaseToolchain,
} from './metadata.types.js';
import { parseInstallationReleaseManifest } from './release-validation.js';

export interface InstallationReleasePolicy {
  readonly supportedSchemaVersions: readonly string[];
  readonly requested?: {
    readonly channel?: ReleaseMetadata['channel'];
    readonly version?: string;
  };
  readonly locators: {
    readonly artifacts: {
      readonly package: (release: ReleaseMetadata) => string;
      readonly packageJson: (release: ReleaseMetadata) => string;
      readonly pnpmLock: (release: ReleaseMetadata) => string;
      readonly pnpmWorkspace: (release: ReleaseMetadata) => string;
    };
    readonly manifest: (version: string) => string;
    readonly channel: (channel: ReleaseMetadata['channel']) => string;
    readonly nodeArchive?: (
      version: string,
      platform: NodeArchivePlatform,
      arch: NodeArchiveArchitecture,
      format: NodeArchiveFormat,
    ) => string;
    readonly nodeShasums?: (version: string) => string;
  };
}

const invalid = (reason: string): Error =>
  new Error(`Invalid Revo installation release policy: ${reason}`);

function isCanonicalHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') {
    return false;
  }
  if (url.username !== '' || url.password !== '') {
    return false;
  }
  // Empty `?`/`#` delimiters survive serialization while `search`/`hash` stay
  // empty, so the raw value is checked for the delimiters as well.
  if (url.search !== '' || url.hash !== '' || value.includes('?') || value.includes('#')) {
    return false;
  }
  // Any form the URL parser rewrites - default ports, host case, literal or
  // percent-encoded dot segments, other noncanonical encodings - is rejected.
  return url.href === value;
}

function isSafeUrlMatch(candidate: string, expected: string): boolean {
  return isCanonicalHttpsUrl(candidate) && isCanonicalHttpsUrl(expected) && candidate === expected;
}

export function validateReleaseManifestUrl(
  url: string,
  version: string,
  policy: InstallationReleasePolicy,
): boolean {
  return isSafeUrlMatch(url, policy.locators.manifest(version));
}

export function validateReleaseChannelUrl(
  url: string,
  channel: ReleaseMetadata['channel'],
  policy: InstallationReleasePolicy,
): boolean {
  return isSafeUrlMatch(url, policy.locators.channel(channel));
}

export function validateInstallationReleaseManifest(
  value: unknown,
  policy: InstallationReleasePolicy,
): InstallationReleaseManifest {
  const manifest = parseInstallationReleaseManifest(value);
  if (!policy.supportedSchemaVersions.includes(manifest.schemaVersion)) {
    throw invalid('schema version is not supported');
  }
  if (
    policy.requested?.channel !== undefined &&
    manifest.release.channel !== policy.requested.channel
  ) {
    throw invalid('release channel does not match the requested channel');
  }
  if (
    policy.requested?.version !== undefined &&
    manifest.release.version !== policy.requested.version
  ) {
    throw invalid('release version does not match the requested version');
  }
  const { release, artifacts } = manifest;
  const artifactLocators: ReadonlyArray<
    readonly [keyof InstallationReleaseManifest['artifacts'], string]
  > = [
    ['package', policy.locators.artifacts.package(release)],
    ['packageJson', policy.locators.artifacts.packageJson(release)],
    ['pnpmLock', policy.locators.artifacts.pnpmLock(release)],
    ['pnpmWorkspace', policy.locators.artifacts.pnpmWorkspace(release)],
  ];
  for (const [kind, expectedUrl] of artifactLocators) {
    if (!isSafeUrlMatch(artifacts[kind].url, expectedUrl)) {
      throw invalid(`${kind} artifact URL does not match the release policy locator`);
    }
  }
  if (manifest.schemaVersion === 'revo-install/v2') {
    validateNodeToolchain(manifest.toolchain, policy);
  }
  return manifest;
}

function validateNodeToolchain(
  toolchain: InstallationReleaseManifest['toolchain'],
  policy: InstallationReleasePolicy,
): asserts toolchain is NodeReleaseToolchain {
  const { nodeArchive, nodeShasums } = policy.locators;
  if (!('nodeArchives' in toolchain) || nodeArchive === undefined || nodeShasums === undefined) {
    throw invalid('Node artifact locators or descriptors are missing');
  }
  if (!isSafeUrlMatch(toolchain.nodeShasums.url, nodeShasums(toolchain.node))) {
    throw invalid('Node SHASUMS URL does not match the release policy locator');
  }
  for (const archive of toolchain.nodeArchives) {
    const expected = nodeArchive(toolchain.node, archive.platform, archive.arch, archive.format);
    if (!isSafeUrlMatch(archive.url, expected)) {
      throw invalid('Node archive URL does not match the release policy locator');
    }
  }
}
