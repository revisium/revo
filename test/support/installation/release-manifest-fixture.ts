import { createHash } from 'node:crypto';

export interface ReleaseManifestFixture {
  readonly manifest: {
    readonly schemaVersion: 'revo-install/v1';
    readonly release: {
      readonly schemaVersion: 1;
      readonly channel: 'stable' | 'alpha';
      readonly version: string;
      readonly npm: {
        readonly name: '@revisium/revo';
        readonly distTag: 'latest' | 'alpha';
      };
    };
    readonly components: {
      readonly core: { readonly name: string; readonly version: string };
      readonly admin: { readonly name: string; readonly version: string };
    };
    readonly toolchain: { readonly node: string; readonly pnpm: string };
    readonly artifacts: {
      readonly package: { readonly url: string; readonly sha256: string; readonly integrity: string };
      readonly packageJson: { readonly url: string; readonly sha256: string };
      readonly pnpmLock: { readonly url: string; readonly sha256: string };
      readonly pnpmWorkspace: { readonly url: string; readonly sha256: string };
    };
  };
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
  versions = {
    core: '0.0.0',
    admin: '0.0.0',
    node: '26.8.2',
    pnpm: '12.4.1',
  },
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
        core: { name: '@revisium/revo-core', version: versions.core },
        admin: { name: '@revisium/revo-admin', version: versions.admin },
      },
      toolchain: { node: versions.node, pnpm: versions.pnpm },
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
