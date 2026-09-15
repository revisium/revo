import {
  pnpmReleaseManifestFixture,
  futureReleasePolicyFixture,
  type ReleaseManifestFixtureOptions,
} from './release-manifest-fixture.js';

export function packageReleaseFixture(options: Omit<ReleaseManifestFixtureOptions, 'policy'> = {}) {
  const fixture = pnpmReleaseManifestFixture({ ...options, policy: futureReleasePolicyFixture() });
  const { release, components, toolchain } = fixture.manifest;
  return {
    ...fixture,
    request: {
      release: { channel: release.channel, version: release.version, distTag: release.npm.distTag },
      components: { core: { ...components.core }, admin: { ...components.admin } },
      target: { platform: 'linux' as const, arch: 'x64' as const },
      toolchain: { node: toolchain.node, pnpm: toolchain.pnpm },
    },
  };
}
