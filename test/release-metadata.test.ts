import { describe, expect, it } from 'vitest';

import { parseReleaseMetadata } from '../src/release-metadata.js';

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
