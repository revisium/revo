import { describe, expect, it } from 'vitest';

import { compareSemVer, parseReleaseMetadata } from '../src/release-metadata.js';

describe('parseReleaseMetadata', () => {
  it.each([
    {
      channel: 'stable',
      npm: { distTag: 'latest', name: '@revisium/revo' },
      schemaVersion: 1,
      version: '1.2.3',
    },
    {
      channel: 'alpha',
      npm: { distTag: 'alpha', name: '@revisium/revo' },
      schemaVersion: 1,
      version: '1.3.0-alpha.2',
    },
  ])('accepts valid $channel metadata', (metadata) => {
    expect(parseReleaseMetadata(metadata)).toEqual(metadata);
  });

  it.each([
    [{}, 'expected schemaVersion'],
    [
      {
        channel: 'stable',
        npm: { distTag: 'latest', name: '@revisium/revo' },
        schemaVersion: 2,
        version: '1.2.3',
      },
      'schemaVersion must be 1',
    ],
    [
      {
        channel: 'stable',
        npm: { distTag: 'alpha', name: '@revisium/revo' },
        schemaVersion: 1,
        version: '1.2.3',
      },
      'stable releases must use the latest npm dist-tag',
    ],
    [
      {
        channel: 'alpha',
        npm: { distTag: 'alpha', name: '@revisium/revo' },
        schemaVersion: 1,
        version: '1.2.3',
      },
      'alpha releases must use prerelease versions',
    ],
    [
      {
        channel: 'stable',
        npm: { distTag: 'latest', name: '@revisium/revo' },
        schemaVersion: 1,
        version: '1.2.3-alpha.1',
      },
      'stable releases cannot use prerelease versions',
    ],
    [
      {
        channel: 'alpha',
        npm: { distTag: 'alpha', name: '@revisium/revo' },
        schemaVersion: 1,
        version: '1.2.3-01',
      },
      'version must be valid SemVer',
    ],
    [
      {
        channel: 'stable',
        extra: true,
        npm: { distTag: 'latest', name: '@revisium/revo' },
        schemaVersion: 1,
        version: '1.2.3',
      },
      'expected schemaVersion',
    ],
  ])('rejects invalid metadata: %j', (metadata, message) => {
    expect(() => parseReleaseMetadata(metadata)).toThrow(message);
  });
});

describe('compareSemVer', () => {
  it('orders versions by SemVer precedence, including prerelease identifiers', () => {
    const ascending = [
      '0.1.0-alpha.2',
      '0.1.0-alpha.10',
      '0.1.0-beta',
      '0.1.0',
      '0.1.1-alpha.1',
      '0.2.0',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '10.0.0',
    ];

    const sorted = ascending.toReversed().toSorted(compareSemVer);

    expect(sorted).toEqual(ascending);
  });

  it('treats versions that differ only in build metadata as equal', () => {
    expect(compareSemVer('0.1.0-alpha.2+build.1', '0.1.0-alpha.2+build.2')).toBe(0);
  });

  it('compares numeric identifiers beyond the safe integer range exactly', () => {
    expect(compareSemVer('1.0.0-9007199254740993', '1.0.0-9007199254740992')).toBeGreaterThan(0);
  });

  it('rejects a value that is not SemVer', () => {
    expect(() => compareSemVer('latest', '1.0.0')).toThrow('latest is not a SemVer version');
  });
});
