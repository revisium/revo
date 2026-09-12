import { describe, expect, it } from 'vitest';

import { resolveRevoLayout } from '../src/layout.js';

describe('resolveRevoLayout JavaScript boundary', () => {
  it.each(['linux', 'darwin', 'win32'])('rejects an invalid channel on %s', (platform) => {
    const homeDir = platform === 'win32' ? 'C:\\Users\\revo' : '/home/revo';

    expect(() =>
      resolveRevoLayout({
        channel: 'beta',
        env: {},
        homeDir,
        platform,
      }),
    ).toThrow('channel must be stable or alpha');
  });
});
