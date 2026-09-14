import { createHash } from 'node:crypto';

import type { InstallationReleaseManifest } from '../../../src/installation/metadata.types.js';

export interface ReleaseManifestFixture {
  readonly manifest: InstallationReleaseManifest;
  readonly bytes: {
    readonly package: Uint8Array;
    readonly packageJson: Uint8Array;
    readonly pnpmLock: Uint8Array;
    readonly pnpmWorkspace: Uint8Array;
  };
}

const digest = (bytes: Uint8Array, algorithm: 'sha256' | 'sha512'): string =>
  createHash(algorithm).update(bytes).digest('hex');

export function releaseManifestFixture(
  channel: 'stable' | 'alpha' = 'stable',
  version = channel === 'stable' ? '1.2.3' : '1.2.3-alpha.1',
): ReleaseManifestFixture {
  const bytes = {
    package: Buffer.from('synthetic revo package bytes'),
    packageJson: Buffer.from('{"name":"@revisium/revo","version":"1.2.3"}'),
    pnpmLock: Buffer.from('lockfileVersion: 9.0\n'),
    pnpmWorkspace: Buffer.from('packages:\n  - .\n'),
  };
  const base = `https://revo.revisium.io/releases/${version}`;
  return {
    bytes,
    manifest: {
      schemaVersion: 'revo-install/v1',
      release: {
        schemaVersion: 1,
        channel,
        version,
        npm: { name: '@revisium/revo', distTag: channel === 'stable' ? 'latest' : 'alpha' },
      },
      components: {
        core: { name: '@revisium/revo-core', version: '0.0.0' },
        admin: { name: '@revisium/revo-admin', version: '0.0.0' },
      },
      toolchain: { node: '26.8.2', pnpm: '12.4.1' },
      artifacts: {
        package: {
          url: `https://registry.npmjs.org/@revisium%2frevo/-/revo-${version}.tgz`,
          sha256: digest(bytes.package, 'sha256'),
          integrity: `sha512-${createHash('sha512').update(bytes.package).digest('base64')}`,
        },
        packageJson: { url: `${base}/package.json`, sha256: digest(bytes.packageJson, 'sha256') },
        pnpmLock: { url: `${base}/pnpm-lock.yaml`, sha256: digest(bytes.pnpmLock, 'sha256') },
        pnpmWorkspace: {
          url: `${base}/pnpm-workspace.yaml`,
          sha256: digest(bytes.pnpmWorkspace, 'sha256'),
        },
      },
    },
  };
}
