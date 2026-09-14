// The installer consumes the same compiled validator as the package runtime.
// Keeping this adapter free of validation logic prevents the two entrypoints drifting.
export {
  parseInstallationReleaseManifest,
  validateReleaseChannelUrl,
  validateReleaseManifestUrl,
  verifyReleaseArtifact,
} from '../../dist/installation/release-validation.js';

export { parseReleaseMetadata } from '../../dist/release-metadata.js';
