import { basename } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  nodeBootstrapScenario,
  officialNodeArchiveSha256,
  officialNodeShasumsSnapshotSha256,
} from './support/installation/node-bootstrap-scenario.js';
import type { NodeArchiveFixture } from './support/installation/release-manifest-fixture.js';

interface NodePlatform {
  selectNodeArchive: (
    manifest: unknown,
    target: { readonly platform: string; readonly arch: string },
  ) => unknown;
  assertBootstrapMatchesManifest: (manifest: unknown, bootstrap: unknown) => void;
}

const nodePlatform = async (): Promise<NodePlatform> => {
  const specifier = new URL('../installer/lib/node-platform.mjs', import.meta.url).href;
  return await vi.importActual<NodePlatform>(specifier);
};

describe('Node platform bootstrap contract', () => {
  it.each([
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['win32', 'x64'],
    ['win32', 'arm64'],
  ])('selects the pinned %s %s archive', async (platform, arch) => {
    const api = await nodePlatform();
    const { fixture, archives } = nodeBootstrapScenario();

    expect(api.selectNodeArchive(fixture.manifest, { platform, arch })).toEqual(
      archives.find((archive) => archive.platform === platform && archive.arch === arch),
    );
  });

  it.each([
    ['missing', (archives: readonly NodeArchiveFixture[]) => archives.slice(1)],
    ['duplicate', (archives: readonly NodeArchiveFixture[]) => [...archives, archives[0]]],
    [
      'extra',
      (archives: readonly NodeArchiveFixture[]) => {
        const firstArchive = archives[0];
        if (firstArchive === undefined) {
          throw new Error('The Node archive fixture must not be empty.');
        }
        return [...archives, { ...firstArchive, arch: 'ppc64' }];
      },
    ],
  ])('rejects a %s archive set', async (_name, mutate) => {
    const api = await nodePlatform();
    const { fixture, archives } = nodeBootstrapScenario();
    const manifest = {
      ...fixture.manifest,
      toolchain: { ...fixture.manifest.toolchain, nodeArchives: mutate(archives) },
    };

    expect(() => api.selectNodeArchive(manifest, { platform: 'linux', arch: 'x64' })).toThrow(
      /Node|node|archive/,
    );
  });

  it.each([
    ['freebsd', 'x64'],
    ['linux', 'ppc64'],
  ])('rejects unsupported target %s %s', async (platform, arch) => {
    const api = await nodePlatform();
    const { fixture } = nodeBootstrapScenario();

    expect(() => api.selectNodeArchive(fixture.manifest, { platform, arch })).toThrow(
      /unsupported/i,
    );
  });

  it('keeps an alternate Node version flowing through archive selection', async () => {
    const api = await nodePlatform();
    const { fixture, bootstrap } = nodeBootstrapScenario('27.3.1');

    expect(
      api.selectNodeArchive(fixture.manifest, { platform: 'linux', arch: 'x64' }),
    ).toMatchObject({
      url: expect.stringContaining('/v27.3.1/node-v27.3.1-linux-x64.tar.xz'),
    });
    expect(bootstrap.snapshotSha256).not.toBe(
      'c31cbd53707d1e82ed2094d4554eb13562a8be9521433f8bc4447776a7e7dad3',
    );
    expect(() => api.assertBootstrapMatchesManifest(fixture.manifest, bootstrap)).not.toThrow();
  });

  it('binds the embedded bootstrap to the official checksum snapshot and manifest', async () => {
    const api = await nodePlatform();
    const { fixture, archives, bootstrap } = nodeBootstrapScenario();
    const official = officialNodeArchiveSha256();

    expect(officialNodeShasumsSnapshotSha256()).toBe(bootstrap.snapshotSha256);
    expect(
      archives.every(({ url, sha256 }) => official.get(basename(new URL(url).pathname)) === sha256),
    ).toBe(true);
    expect(() => api.assertBootstrapMatchesManifest(fixture.manifest, bootstrap)).not.toThrow();
  });

  it.each([
    [
      'version',
      (bootstrap: ReturnType<typeof nodeBootstrapScenario>['bootstrap']) => ({
        ...bootstrap,
        nodeVersion: '26.8.1',
      }),
    ],
    [
      'archives',
      (bootstrap: ReturnType<typeof nodeBootstrapScenario>['bootstrap']) => ({
        ...bootstrap,
        archives: bootstrap.archives.slice(1),
      }),
    ],
    [
      'archive hash',
      (bootstrap: ReturnType<typeof nodeBootstrapScenario>['bootstrap']) => ({
        ...bootstrap,
        archives: bootstrap.archives.map((archive, index) =>
          index === 0 ? { ...archive, sha256: '0'.repeat(64) } : archive,
        ),
      }),
    ],
    [
      'snapshot',
      (bootstrap: ReturnType<typeof nodeBootstrapScenario>['bootstrap']) => ({
        ...bootstrap,
        snapshotSha256: '0'.repeat(64),
      }),
    ],
  ])('rejects a bootstrap with mismatched %s identity', async (_name, mutate) => {
    const api = await nodePlatform();
    const { fixture, bootstrap } = nodeBootstrapScenario();

    expect(() => api.assertBootstrapMatchesManifest(fixture.manifest, mutate(bootstrap))).toThrow(
      /Node|node|bootstrap|archive/,
    );
  });
});
