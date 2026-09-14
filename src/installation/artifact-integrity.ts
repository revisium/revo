import { createHash } from 'node:crypto';

import type { PackageReleaseArtifact, ReleaseArtifact } from './metadata.types.js';

// Descriptor syntax is validated once by the manifest decoder; verification only
// recomputes the digests and compares them to the pinned strings.
export function verifyReleaseArtifact(
  bytes: Uint8Array,
  descriptor: ReleaseArtifact | PackageReleaseArtifact,
): boolean {
  if (createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) {
    throw new Error('Release artifact hash verification failed.');
  }
  if ('integrity' in descriptor) {
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    if (integrity !== descriptor.integrity) {
      throw new Error('Release artifact integrity verification failed.');
    }
  }
  return true;
}
