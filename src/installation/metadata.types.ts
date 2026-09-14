import type { ReleaseMetadata } from '../release-metadata.js';

export interface ReleaseArtifact {
  readonly url: string;
  readonly sha256: string;
}

export interface PackageReleaseArtifact extends ReleaseArtifact {
  readonly integrity: string;
}

export interface InstallationReleaseManifest {
  readonly schemaVersion: 'revo-install/v1';
  readonly release: ReleaseMetadata;
  readonly components: {
    readonly core: { readonly name: '@revisium/revo-core'; readonly version: '0.0.0' };
    readonly admin: { readonly name: '@revisium/revo-admin'; readonly version: '0.0.0' };
  };
  readonly toolchain: { readonly node: '26.8.2'; readonly pnpm: '12.4.1' };
  readonly artifacts: {
    readonly package: PackageReleaseArtifact;
    readonly packageJson: ReleaseArtifact;
    readonly pnpmLock: ReleaseArtifact;
    readonly pnpmWorkspace: ReleaseArtifact;
  };
}
