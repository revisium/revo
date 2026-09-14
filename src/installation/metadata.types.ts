import type { ReleaseMetadata } from '../release-metadata.js';

export interface ReleaseArtifact {
  readonly url: string;
  readonly sha256: string;
}

export interface PackageReleaseArtifact extends ReleaseArtifact {
  readonly integrity: string;
}

export interface InstallationReleaseManifest {
  readonly schemaVersion: string;
  readonly release: ReleaseMetadata;
  readonly components: {
    readonly core: { readonly name: string; readonly version: string };
    readonly admin: { readonly name: string; readonly version: string };
  };
  readonly toolchain: { readonly node: string; readonly pnpm: string };
  readonly artifacts: {
    readonly package: PackageReleaseArtifact;
    readonly packageJson: ReleaseArtifact;
    readonly pnpmLock: ReleaseArtifact;
    readonly pnpmWorkspace: ReleaseArtifact;
  };
}
