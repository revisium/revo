import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  parseInstallationReleaseManifest,
  validateReleaseChannelUrl,
  validateReleaseManifestUrl,
  verifyReleaseArtifact,
} from '../../src/installation/release-validation.js';
import { releaseManifestFixture } from '../support/installation/release-manifest-fixture.js';

describe('installation release contract', () => {
  it.each([
    {
      release: '2.7.1',
      versions: { core: '4.3.2', admin: '5.4.3', node: '28.1.0', pnpm: '13.0.2' },
    },
    {
      release: '3.0.0',
      versions: {
        core: '6.0.0-beta.2',
        admin: '7.8.9+build.4',
        node: '30.0.0-rc.1',
        pnpm: '14.2.1',
      },
    },
  ])('preserves valid release-specific versions for release $release', ({ release, versions }) => {
    const fixture = releaseManifestFixture('stable', release, versions);

    expect(parseInstallationReleaseManifest(fixture.manifest)).toEqual(fixture.manifest);
  });

  it.each(['stable', 'alpha'] as const)(
    'accepts a valid %s manifest and verifies every artifact',
    (channel) => {
      const fixture = releaseManifestFixture(channel);
      expect(
        parseInstallationReleaseManifest(fixture.manifest, {
          channel,
          version: fixture.manifest.release.version,
        }),
      ).toEqual(fixture.manifest);
      const artifacts = [
        ['package', fixture.manifest.artifacts.package, fixture.bytes.package],
        ['packageJson', fixture.manifest.artifacts.packageJson, fixture.bytes.packageJson],
        ['pnpmLock', fixture.manifest.artifacts.pnpmLock, fixture.bytes.pnpmLock],
        ['pnpmWorkspace', fixture.manifest.artifacts.pnpmWorkspace, fixture.bytes.pnpmWorkspace],
      ] as const;
      artifacts.forEach(([, descriptor, bytes]) => {
        expect(verifyReleaseArtifact(bytes, descriptor)).toBe(true);
      });
    },
  );

  it('rejects requested release mismatches, unknown fields, and invalid pins', () => {
    const fixture = releaseManifestFixture();
    expect(() => parseInstallationReleaseManifest(fixture.manifest, { channel: 'alpha' })).toThrow(
      /channel/,
    );
    expect(() => parseInstallationReleaseManifest({ ...fixture.manifest, unknown: true })).toThrow(
      /schema/,
    );
    expect(() =>
      parseInstallationReleaseManifest({
        ...fixture.manifest,
        toolchain: { node: '24.0.0', pnpm: '12.4.1' },
      }),
    ).toThrow(/schema/);
  });

  it.each([
    'http://revo.revisium.io/releases/1.2.3/manifest.json',
    'https://revo.revisium.io/releases/1.2.3/manifest.json?x=1',
    'https://revo.revisium.io/releases/1.2.3/manifest.json#x',
    'https://revo.revisium.io/releases/1.2.3/../manifest.json',
    'https://REVO.REVISIUM.IO/releases/1.2.3/manifest.json',
    'https://revo.revisium.io:443/releases/1.2.3/manifest.json',
  ])('rejects unsafe distribution URL %s', (url) => {
    expect(validateReleaseManifestUrl(url, '1.2.3')).toBe(false);
  });

  it.each([
    'https://registry.npmjs.org/@revisium/revo/-/revo-1.2.3.tgz',
    'https://registry.npmjs.org/@revisium%2Frevo/-/revo-1.2.3.tgz',
    'https://registry.npmjs.org/@revisium%2frevo/-/revo-1.2.4.tgz',
    'https://user:pass@registry.npmjs.org/@revisium%2frevo/-/revo-1.2.3.tgz',
    'https://registry.npmjs.org/@revisium%2frevo/-/revo-1.2.3.tgz?x=1',
  ])('rejects unsafe package URL %s', (url) => {
    const fixture = releaseManifestFixture();
    expect(() =>
      parseInstallationReleaseManifest({
        ...fixture.manifest,
        artifacts: {
          ...fixture.manifest.artifacts,
          package: { ...fixture.manifest.artifacts.package, url },
        },
      }),
    ).toThrow(/artifact/);
  });

  it('accepts only the approved manifest and channel pointers', () => {
    expect(
      validateReleaseManifestUrl('https://revo.revisium.io/releases/1.2.3/manifest.json', '1.2.3'),
    ).toBe(true);
    expect(
      validateReleaseChannelUrl('https://revo.revisium.io/channels/stable.json', 'stable'),
    ).toBe(true);
    expect(validateReleaseChannelUrl('https://revo.revisium.io/channels/alpha.json', 'alpha')).toBe(
      true,
    );
    expect(
      validateReleaseChannelUrl('https://revo.revisium.io/channels/stable.json?x=1', 'stable'),
    ).toBe(false);
  });

  it('detects tampering without echoing artifact URLs', () => {
    const fixture = releaseManifestFixture();
    const descriptor = fixture.manifest.artifacts.packageJson;
    expect(() => verifyReleaseArtifact(Buffer.from('tampered'), descriptor)).toThrow(
      /hash verification failed/,
    );
    expect(() => verifyReleaseArtifact(Buffer.from('tampered'), descriptor)).toThrow(
      new Error('Release artifact hash verification failed.'),
    );
  });

  it('distinguishes a matching SHA-256 from a tampered package integrity', () => {
    const fixture = releaseManifestFixture();
    const bytes = Buffer.from('different package bytes');
    const descriptor = {
      ...fixture.manifest.artifacts.package,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    expect(() => verifyReleaseArtifact(bytes, descriptor)).toThrow(/integrity verification failed/);
  });

  it.each(['sha512-not-base64', `sha512-${'A'.repeat(85)}B==`])(
    'rejects noncanonical SRI %s',
    (integrity) => {
      const fixture = releaseManifestFixture();
      expect(() =>
        parseInstallationReleaseManifest({
          ...fixture.manifest,
          artifacts: {
            ...fixture.manifest.artifacts,
            package: { ...fixture.manifest.artifacts.package, integrity },
          },
        }),
      ).toThrow(/integrity/);
    },
  );
});
