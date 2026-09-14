import type { ReleaseMetadata } from '../release-metadata.js';

export interface ReleaseArtifact {
  readonly url: string;
  readonly sha256: string;
}

export interface PackageReleaseArtifact extends ReleaseArtifact {
  readonly integrity: string;
}

export type NodeArchivePlatform = 'darwin' | 'linux' | 'win32';
export type NodeArchiveArchitecture = 'arm64' | 'x64';
export type NodeArchiveFormat = 'tar.gz' | 'tar.xz' | 'zip';

export interface NodeArchiveReleaseArtifact extends ReleaseArtifact {
  readonly platform: NodeArchivePlatform;
  readonly arch: NodeArchiveArchitecture;
  readonly format: NodeArchiveFormat;
}

export interface NodeReleaseToolchain {
  readonly node: string;
  readonly pnpm: string;
  readonly nodeArchives: readonly NodeArchiveReleaseArtifact[];
  readonly nodeShasums: ReleaseArtifact;
}

export interface LegacyReleaseToolchain {
  readonly node: string;
  readonly pnpm: string;
}

interface InstallationReleaseManifestFields {
  readonly release: ReleaseMetadata;
  readonly components: {
    readonly core: { readonly name: string; readonly version: string };
    readonly admin: { readonly name: string; readonly version: string };
  };
  readonly artifacts: {
    readonly package: PackageReleaseArtifact;
    readonly packageJson: ReleaseArtifact;
    readonly pnpmLock: ReleaseArtifact;
    readonly pnpmWorkspace: ReleaseArtifact;
  };
}

export interface LegacyInstallationReleaseManifest extends InstallationReleaseManifestFields {
  readonly schemaVersion: 'revo-install/v1';
  readonly toolchain: LegacyReleaseToolchain;
}

export interface NodeInstallationReleaseManifest extends InstallationReleaseManifestFields {
  readonly schemaVersion: 'revo-install/v2';
  readonly toolchain: NodeReleaseToolchain;
}

declare const unknownInstallationSchemaVersion: unique symbol;

export type UnknownInstallationSchemaVersion = string & {
  readonly [unknownInstallationSchemaVersion]: true;
};

export interface UnknownInstallationReleaseManifest extends InstallationReleaseManifestFields {
  readonly schemaVersion: UnknownInstallationSchemaVersion;
  readonly toolchain: LegacyReleaseToolchain;
}

export type InstallationReleaseManifest =
  | LegacyInstallationReleaseManifest
  | NodeInstallationReleaseManifest
  | UnknownInstallationReleaseManifest;
