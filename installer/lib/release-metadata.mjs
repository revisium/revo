// The installer consumes the same compiled validator as the package runtime.
// Keeping this adapter free of validation logic prevents the two entrypoints drifting.
// Callers must supply their own InstallationReleasePolicy; no default policy is exported here.
export { parseInstallationReleaseManifest } from '../../dist/installation/release-validation.js';

export {
  validateInstallationReleaseManifest,
  validateReleaseChannelUrl,
  validateReleaseManifestUrl,
} from '../../dist/installation/release-policy.js';

export { verifyReleaseArtifact } from '../../dist/installation/artifact-integrity.js';

export { parseReleaseMetadata } from '../../dist/release-metadata.js';
