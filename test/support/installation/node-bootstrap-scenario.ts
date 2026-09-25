import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { futureReleaseManifestFixture } from './release-manifest-fixture.js';

export const NODE_SHASUMS_SNAPSHOT_SHA256 =
  'c31cbd53707d1e82ed2094d4554eb13562a8be9521433f8bc4447776a7e7dad3';

export const nodeBootstrapScenario = (nodeVersion = '26.8.2') => {
  const fixture = futureReleaseManifestFixture({
    versions: { core: '0.0.0', admin: '0.0.0', node: nodeVersion, pnpm: '12.5.1' },
  });
  const archives = fixture.manifest.toolchain.nodeArchives;
  const bootstrap = {
    nodeVersion,
    archives: archives.map((archive) => ({ ...archive })),
    snapshotSha256:
      nodeVersion === '26.8.2'
        ? NODE_SHASUMS_SNAPSHOT_SHA256
        : fixture.manifest.toolchain.nodeShasums.sha256,
  };
  return { fixture, archives, bootstrap };
};

export const officialNodeShasumsSnapshotSha256 = (): string =>
  createHash('sha256')
    .update(
      readFileSync(
        new URL('../../fixtures/installation/node-v26.8.2-SHASUMS256.txt', import.meta.url),
      ),
    )
    .digest('hex');

export const officialNodeArchiveSha256 = (): ReadonlyMap<string, string> => {
  const entries = readFileSync(
    new URL('../../fixtures/installation/node-v26.8.2-SHASUMS256.txt', import.meta.url),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^([a-f0-9]{64})  (\S+)$/.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) {
        throw new Error('Invalid Node checksum fixture line.');
      }
      return [match[2], match[1]] as const;
    });
  const checksums = new Map(entries);
  if (checksums.size !== entries.length) {
    throw new Error('Duplicate filename in Node checksum fixture.');
  }
  return checksums;
};
