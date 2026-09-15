import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { verifyReleaseArtifact } from '../../src/installation/artifact-integrity.js';
import type { InstallationReleaseManifest } from '../../src/installation/metadata.types.js';
import type { InstallationReleasePolicy } from '../../src/installation/release-policy.js';
import {
  validateInstallationReleaseManifest,
  validateReleaseChannelUrl,
  validateReleaseManifestUrl,
} from '../../src/installation/release-policy.js';
import { parseInstallationReleaseManifest } from '../../src/installation/release-validation.js';
import {
  futureReleaseManifestFixture,
  futureReleasePolicyFixture,
  releaseManifestFixture,
  releasePolicyFixture,
  pnpmReleaseManifestFixture,
} from '../support/installation/release-manifest-fixture.js';

const ORIGIN = 'https://revo.revisium.io';
const MIRROR_ORIGIN = 'https://mirror.revisium.io';

interface InstallerAdapter {
  readonly validateInstallationReleaseManifest: typeof validateInstallationReleaseManifest;
  readonly verifyReleaseArtifact: typeof verifyReleaseArtifact;
}

// The compiled adapter is produced by `pnpm build`, which `pnpm test` and
// `pnpm test:cov` run first; the specifier is assembled at runtime because the
// emitted JavaScript is outside the TypeScript program.
const installerAdapter = async (): Promise<InstallerAdapter> => {
  const specifier = new URL('../../installer/lib/release-metadata.mjs', import.meta.url).href;
  return await vi.importActual<InstallerAdapter>(specifier);
};

describe('installation release contract', () => {
  it('decodes and validates v3 with six trusted pnpm archives', () => {
    const fixture = pnpmReleaseManifestFixture();
    expect(parseInstallationReleaseManifest(fixture.manifest)).toEqual(fixture.manifest);
    expect(validateInstallationReleaseManifest(fixture.manifest, fixture.policy)).toEqual(
      fixture.manifest,
    );
    expect(fixture.manifest.toolchain.pnpmArchives).toHaveLength(6);
  });

  it('keeps pnpm metadata release-specific without leaking fixture pins', () => {
    const fixture = pnpmReleaseManifestFixture({
      versions: {
        core: '4.3.2',
        admin: '5.4.3',
        node: '28.1.0',
        pnpm: '13.0.2',
      },
    });
    expect(fixture.manifest.toolchain.pnpmArchives).toHaveLength(6);
    expect(fixture.manifest.toolchain.pnpmArchives[0]?.url).toContain('/v13.0.2/');
    expect(fixture.manifest.toolchain.pnpmArchives.map(({ sha256 }) => sha256)).not.toContain(
      '432fd151c10477630cf5c9f41209c2a7b75ac6dce7b2533a459519daf8954c52',
    );
    expect(validateInstallationReleaseManifest(fixture.manifest, fixture.policy)).toEqual(
      fixture.manifest,
    );
  });

  it.each([
    ['unknown target', { platform: 'freebsd' }],
    ['wrong format', { format: 'tar.xz' }],
    ['invalid hash', { sha256: 'not-a-sha256' }],
  ])('rejects malformed v3 pnpm archive: %s', (_name, change) => {
    const fixture = pnpmReleaseManifestFixture();
    const pnpmArchives = fixture.manifest.toolchain.pnpmArchives.map((archive, index) =>
      index === 0 ? { ...archive, ...change } : archive,
    );
    expect(() =>
      parseInstallationReleaseManifest({
        ...fixture.manifest,
        toolchain: { ...fixture.manifest.toolchain, pnpmArchives },
      }),
    ).toThrow(/pnpm|archive|schema|hash/iu);
  });

  it.each([
    'https://github.com/pnpm/pnpm/releases/download/v12.4.1/pnpm-linux-x64.tar.gz?x=1',
    'https://github.com/pnpm/pnpm/releases/download/v12.4.1/pnpm-linux-x64.zip',
    'https://foreign.example/pnpm-linux-x64.tar.gz',
  ])('rejects a noncanonical v3 pnpm URL: %s', (url) => {
    const fixture = pnpmReleaseManifestFixture();
    const pnpmArchives = fixture.manifest.toolchain.pnpmArchives.map((archive, index) =>
      index === 0 ? { ...archive, url } : archive,
    );
    expect(() =>
      validateInstallationReleaseManifest(
        {
          ...fixture.manifest,
          toolchain: { ...fixture.manifest.toolchain, pnpmArchives },
        },
        fixture.policy,
      ),
    ).toThrow(/pnpm/iu);
  });

  it('decodes a v2 manifest carrying the complete pinned Node archive set', () => {
    const fixture = futureReleaseManifestFixture();

    expect(parseInstallationReleaseManifest(fixture.manifest)).toEqual(fixture.manifest);
  });

  it('rejects toolchain fields that do not match the declared schema version', () => {
    const legacyFixture = releaseManifestFixture();
    expect(() =>
      parseInstallationReleaseManifest({
        ...legacyFixture.manifest,
        schemaVersion: 'revo-install/v2',
      }),
    ).toThrow(/schema/);

    const futureFixture = futureReleaseManifestFixture();
    expect(() =>
      parseInstallationReleaseManifest({
        ...futureFixture.manifest,
        schemaVersion: 'revo-install/v1',
      }),
    ).toThrow(/schema/);
  });

  it.each(['nodeArchive', 'nodeShasums'] as const)(
    'accepts v2 only when every %s URL matches its policy locator',
    (locator) => {
      const policy = futureReleasePolicyFixture({ supportedSchemaVersions: ['revo-install/v2'] });
      const fixture = futureReleaseManifestFixture({ policy });
      expect(validateInstallationReleaseManifest(fixture.manifest, policy)).toEqual(
        fixture.manifest,
      );
      const mismatched = {
        ...policy,
        locators: { ...policy.locators, [locator]: () => 'https://invalid.example/archive' },
      };
      expect(() => validateInstallationReleaseManifest(fixture.manifest, mismatched)).toThrow(
        /Node|node/,
      );
    },
  );

  it.each([
    ['archive URL', 'https://nodejs.org/dist/v26.8.2/node-v26.8.2-linux-arm64.tar.xz'],
    ['canonical URL', 'https://nodejs.org/dist/v26.8.2/node-v26.8.2-linux-x64.tar.xz?mirror=1'],
  ])('rejects a mismatched Node %s through release policy', (_name, url) => {
    const policy = futureReleasePolicyFixture({
      supportedSchemaVersions: ['revo-install/v2'],
    });
    const fixture = futureReleaseManifestFixture({ policy });
    const nodeArchives = fixture.manifest.toolchain.nodeArchives.map((archive, index) =>
      index === 0 ? { ...archive, url } : archive,
    );
    const manifest = {
      ...fixture.manifest,
      toolchain: { ...fixture.manifest.toolchain, nodeArchives },
    };

    expect(() => validateInstallationReleaseManifest(manifest, fixture.policy)).toThrow(
      /Node|node/,
    );
  });

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
    const fixture = releaseManifestFixture({ version: release, versions });

    expect(parseInstallationReleaseManifest(fixture.manifest)).toEqual(fixture.manifest);
  });

  it.each(['stable', 'alpha'] as const)(
    'accepts a valid %s manifest and verifies every artifact',
    (channel) => {
      const fixture = releaseManifestFixture({ channel });
      const policy = releasePolicyFixture({
        requested: { channel, version: fixture.manifest.release.version },
      });
      const decoded = validateInstallationReleaseManifest(fixture.manifest, policy);
      expect(decoded).toEqual(fixture.manifest);
      // Bytes are checked against the descriptors the decoder returned, not the
      // raw fixture input, so verification only trusts validated metadata.
      const artifacts = [
        [decoded.artifacts.package, fixture.bytes.package],
        [decoded.artifacts.packageJson, fixture.bytes.packageJson],
        [decoded.artifacts.pnpmLock, fixture.bytes.pnpmLock],
        [decoded.artifacts.pnpmWorkspace, fixture.bytes.pnpmWorkspace],
      ] as const;
      artifacts.forEach(([descriptor, bytes]) => {
        expect(verifyReleaseArtifact(bytes, descriptor)).toBe(true);
      });
    },
  );

  it('accepts a second root and rejects that manifest from a foreign origin', () => {
    const mirrorPolicy = releasePolicyFixture({
      distributionRoot: MIRROR_ORIGIN,
      registryRoot: 'https://registry.mirror.revisium.io',
    });
    const fixture = releaseManifestFixture({ policy: mirrorPolicy });
    expect(validateInstallationReleaseManifest(fixture.manifest, mirrorPolicy)).toEqual(
      fixture.manifest,
    );
    expect(() =>
      validateInstallationReleaseManifest(fixture.manifest, releasePolicyFixture()),
    ).toThrow(/package artifact URL/);
    const mirrorManifestUrl = `${MIRROR_ORIGIN}/releases/1.2.3/manifest.json`;
    expect(validateReleaseManifestUrl(mirrorManifestUrl, '1.2.3', mirrorPolicy)).toBe(true);
    expect(
      validateReleaseManifestUrl(`${ORIGIN}/releases/1.2.3/manifest.json`, '1.2.3', mirrorPolicy),
    ).toBe(false);
  });

  it('rejects requested channel/version policy mismatches', () => {
    const fixture = releaseManifestFixture();
    expect(() =>
      validateInstallationReleaseManifest(
        fixture.manifest,
        releasePolicyFixture({ requested: { channel: 'alpha' } }),
      ),
    ).toThrow(/channel/);
    expect(() =>
      validateInstallationReleaseManifest(
        fixture.manifest,
        releasePolicyFixture({ requested: { version: '9.9.9' } }),
      ),
    ).toThrow(/version/);
  });

  it('decodes an unsupported installation schema version but rejects it by policy', () => {
    const fixture = releaseManifestFixture();
    const manifest = { ...fixture.manifest, schemaVersion: 'revo-install/v99' };
    expect(parseInstallationReleaseManifest(manifest)).toEqual(manifest);
    expect(() => validateInstallationReleaseManifest(manifest, releasePolicyFixture())).toThrow(
      /schema version/,
    );
    expect(() =>
      validateInstallationReleaseManifest(
        fixture.manifest,
        releasePolicyFixture({ supportedSchemaVersions: ['revo-install/v2'] }),
      ),
    ).toThrow(/schema version/);
  });

  const malformedKeyCases: ReadonlyArray<
    [string, (manifest: InstallationReleaseManifest) => unknown, RegExp]
  > = [
    ['an unknown root field', (manifest) => ({ ...manifest, unknown: true }), /schema/],
    [
      'a missing toolchain key',
      (manifest) => ({ ...manifest, toolchain: { node: manifest.toolchain.node } }),
      /schema/,
    ],
    [
      'a nested extra toolchain key',
      (manifest) => ({ ...manifest, toolchain: { ...manifest.toolchain, bun: '1.0.0' } }),
      /schema/,
    ],
    [
      'a nested extra artifact key',
      (manifest) => ({
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          pnpmLock: { ...manifest.artifacts.pnpmLock, size: 12 },
        },
      }),
      /artifact/,
    ],
    [
      'a package artifact missing its integrity key',
      (manifest) => ({
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          package: {
            url: manifest.artifacts.package.url,
            sha256: manifest.artifacts.package.sha256,
          },
        },
      }),
      /artifact/,
    ],
    [
      'a nested extra component key',
      (manifest) => ({
        ...manifest,
        components: {
          ...manifest.components,
          admin: { ...manifest.components.admin, optional: true },
        },
      }),
      /component/,
    ],
  ];

  it.each(malformedKeyCases)('rejects %s', (_name, mutate, pattern) => {
    const fixture = releaseManifestFixture();
    expect(() => parseInstallationReleaseManifest(mutate(fixture.manifest))).toThrow(pattern);
  });

  it.each(['0'.repeat(63), '0'.repeat(65), 'g'.repeat(64), 'A'.repeat(64), ''])(
    'rejects malformed artifact SHA-256 %s',
    (sha256) => {
      const fixture = releaseManifestFixture();
      expect(() =>
        parseInstallationReleaseManifest({
          ...fixture.manifest,
          artifacts: {
            ...fixture.manifest.artifacts,
            packageJson: { ...fixture.manifest.artifacts.packageJson, sha256 },
          },
        }),
      ).toThrow(/artifact/);
    },
  );

  it.each(['24.0', 'not-a-version'])('rejects malformed toolchain SemVer %s', (node) => {
    const fixture = releaseManifestFixture();
    expect(() =>
      parseInstallationReleaseManifest({
        ...fixture.manifest,
        toolchain: { ...fixture.manifest.toolchain, node },
      }),
    ).toThrow(/schema/);
  });

  it('rejects component pins with malformed SemVer', () => {
    const fixture = releaseManifestFixture();
    expect(() =>
      parseInstallationReleaseManifest({
        ...fixture.manifest,
        components: {
          ...fixture.manifest.components,
          core: { ...fixture.manifest.components.core, version: 'not-a-version' },
        },
      }),
    ).toThrow(/component/);
  });

  it.each(['@revisium/revo-core-next', 'revo-core', '@scope-1/core.pkg_2'])(
    'preserves a component pin that uses the valid package name %s',
    (name) => {
      const fixture = releaseManifestFixture();
      const manifest = {
        ...fixture.manifest,
        components: {
          ...fixture.manifest.components,
          core: { ...fixture.manifest.components.core, name },
        },
      };
      expect(parseInstallationReleaseManifest(manifest)).toEqual(manifest);
    },
  );

  it.each([
    '',
    '@revisium/',
    '@/revo-core',
    'Revo-Core',
    '@Revisium/revo-core',
    '.revo-core',
    'revo core',
    `@revisium/${'a'.repeat(214)}`,
  ])('rejects the malformed component package name %s', (name) => {
    const fixture = releaseManifestFixture();
    expect(() =>
      parseInstallationReleaseManifest({
        ...fixture.manifest,
        components: {
          ...fixture.manifest.components,
          core: { ...fixture.manifest.components.core, name },
        },
      }),
    ).toThrow(/component/);
  });

  it.each([
    'http://revo.revisium.io/releases/1.2.3/manifest.json',
    'https://revo.revisium.io/releases/1.2.3/manifest.json?x=1',
    'https://revo.revisium.io/releases/1.2.3/manifest.json#x',
    'https://revo.revisium.io/releases/1.2.3/../manifest.json',
    'https://REVO.REVISIUM.IO/releases/1.2.3/manifest.json',
    'https://revo.revisium.io:443/releases/1.2.3/manifest.json',
  ])('rejects unsafe distribution URL %s', (url) => {
    expect(validateReleaseManifestUrl(url, '1.2.3', releasePolicyFixture())).toBe(false);
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
      validateInstallationReleaseManifest(
        {
          ...fixture.manifest,
          artifacts: {
            ...fixture.manifest.artifacts,
            package: { ...fixture.manifest.artifacts.package, url },
          },
        },
        releasePolicyFixture(),
      ),
    ).toThrow(/package artifact URL/);
  });

  it.each([
    'https://revo.revisium.io/releases/1.2.3/../manifest.json',
    'https://revo.revisium.io/releases/./1.2.3/manifest.json',
    'https://revo.revisium.io/releases/1.2.3/%2e%2e/manifest.json',
    'https://revo.revisium.io/releases/1.2.3/%2E%2E/manifest.json',
    'http://revo.revisium.io/releases/1.2.3/manifest.json',
    'https://user:pass@revo.revisium.io/releases/1.2.3/manifest.json',
    'https://revo.revisium.io/releases/1.2.3/manifest.json?x=1',
    'https://revo.revisium.io/releases/1.2.3/manifest.json#x',
    'https://revo.revisium.io/releases/1.2.3/manifest.json?',
    'https://revo.revisium.io/releases/1.2.3/manifest.json#',
  ])('rejects noncanonical candidate manifest URL %s', (url) => {
    expect(validateReleaseManifestUrl(url, '1.2.3', releasePolicyFixture())).toBe(false);
  });

  it.each([
    (version: string) => `http://revo.revisium.io/releases/${version}/manifest.json`,
    (version: string) => `https://user:pass@revo.revisium.io/releases/${version}/manifest.json`,
    (version: string) => `${ORIGIN}/releases/${version}/../manifest.json`,
    (version: string) => `${ORIGIN}/releases/${version}/%2e%2e/manifest.json`,
    (version: string) => `${ORIGIN}/releases/${version}/manifest.json?x=1`,
    (version: string) => `${ORIGIN}/releases/${version}/manifest.json#x`,
    // Empty `?`/`#` delimiters survive serialization, so a candidate can equal a
    // noncanonical locator byte for byte and still has to be rejected.
    (version: string) => `${ORIGIN}/releases/${version}/manifest.json?`,
    (version: string) => `${ORIGIN}/releases/${version}/manifest.json#`,
  ])('rejects a candidate that matches a noncanonical policy locator #%#', (manifest) => {
    const base = releasePolicyFixture();
    const policy: InstallationReleasePolicy = {
      ...base,
      locators: { ...base.locators, manifest },
    };
    expect(validateReleaseManifestUrl(manifest('1.2.3'), '1.2.3', policy)).toBe(false);
  });

  it('rejects a channel pointer that matches a noncanonical policy locator', () => {
    const base = releasePolicyFixture();
    const policy: InstallationReleasePolicy = {
      ...base,
      locators: { ...base.locators, channel: (channel) => `${ORIGIN}/channels/${channel}.json#x` },
    };
    expect(validateReleaseChannelUrl(`${ORIGIN}/channels/stable.json#x`, 'stable', policy)).toBe(
      false,
    );
  });

  it('rejects a manifest whose artifact URLs mix two different roots', () => {
    const fixture = releaseManifestFixture();
    const otherRoot = releaseManifestFixture({
      policy: releasePolicyFixture({ distributionRoot: MIRROR_ORIGIN }),
    });
    expect(() =>
      validateInstallationReleaseManifest(
        {
          ...fixture.manifest,
          artifacts: {
            ...fixture.manifest.artifacts,
            packageJson: otherRoot.manifest.artifacts.packageJson,
          },
        },
        releasePolicyFixture(),
      ),
    ).toThrow(/packageJson artifact URL/);
  });

  it('rejects a manifest where artifact URLs are swapped between kinds', () => {
    const fixture = releaseManifestFixture();
    expect(() =>
      validateInstallationReleaseManifest(
        {
          ...fixture.manifest,
          artifacts: {
            ...fixture.manifest.artifacts,
            packageJson: {
              ...fixture.manifest.artifacts.packageJson,
              url: fixture.manifest.artifacts.pnpmLock.url,
            },
          },
        },
        releasePolicyFixture(),
      ),
    ).toThrow(/packageJson artifact URL/);
  });

  it('accepts only the approved manifest and channel pointers', () => {
    const policy = releasePolicyFixture();
    expect(
      validateReleaseManifestUrl(`${ORIGIN}/releases/1.2.3/manifest.json`, '1.2.3', policy),
    ).toBe(true);
    expect(validateReleaseChannelUrl(`${ORIGIN}/channels/stable.json`, 'stable', policy)).toBe(
      true,
    );
    expect(validateReleaseChannelUrl(`${ORIGIN}/channels/alpha.json`, 'alpha', policy)).toBe(true);
    expect(validateReleaseChannelUrl(`${ORIGIN}/channels/stable.json?x=1`, 'stable', policy)).toBe(
      false,
    );
  });

  it('detects tampering without echoing artifact URLs', () => {
    const fixture = releaseManifestFixture();
    const descriptor = parseInstallationReleaseManifest(fixture.manifest).artifacts.packageJson;
    // The exact error carries no URL, so a single assertion covers both the
    // failure and the message shape.
    expect(() => verifyReleaseArtifact(Buffer.from('tampered'), descriptor)).toThrow(
      new Error('Release artifact hash verification failed.'),
    );
  });

  it('distinguishes a matching SHA-256 from a tampered package integrity', () => {
    const fixture = releaseManifestFixture();
    const bytes = Buffer.from('different package bytes');
    const descriptor = {
      ...parseInstallationReleaseManifest(fixture.manifest).artifacts.package,
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

  it('enforces the same explicit policy through the compiled installer adapter', async () => {
    const adapter = await installerAdapter();
    const fixture = releaseManifestFixture();
    const policy = releasePolicyFixture({ requested: { channel: 'stable', version: '1.2.3' } });
    const decoded = adapter.validateInstallationReleaseManifest(fixture.manifest, policy);
    expect(decoded).toEqual(fixture.manifest);
    expect(adapter.verifyReleaseArtifact(fixture.bytes.package, decoded.artifacts.package)).toBe(
      true,
    );
    expect(() =>
      adapter.validateInstallationReleaseManifest(
        fixture.manifest,
        releasePolicyFixture({ requested: { version: '9.9.9' } }),
      ),
    ).toThrow(/version/);
  });
});
