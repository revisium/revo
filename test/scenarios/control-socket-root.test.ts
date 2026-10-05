import { describe, expect, it } from 'vitest';

import { buildCoreChildEnvironment } from '../../src/core-host/core-child-environment.js';
import { controlSocketRoot } from '../../src/processes/control-endpoint.directory.js';

describe('control socket root', () => {
  it('defaults to /tmp when no override is set', () => {
    expect(controlSocketRoot({})).toBe('/tmp');
    expect(controlSocketRoot({ REVO_CONTROL_SOCKET_ROOT: '' })).toBe('/tmp');
  });

  it('uses an absolute override and rejects a relative one', () => {
    expect(controlSocketRoot({ REVO_CONTROL_SOCKET_ROOT: '/tmp/revo-t-x' })).toBe('/tmp/revo-t-x');
    expect(() => controlSocketRoot({ REVO_CONTROL_SOCKET_ROOT: 'relative' })).toThrow(/absolute/u);
  });

  it('reaches the server and Core children through their environment allowlist', () => {
    const { env } = buildCoreChildEnvironment({ REVO_CONTROL_SOCKET_ROOT: '/tmp/revo-t-x' });

    expect(env.REVO_CONTROL_SOCKET_ROOT).toBe('/tmp/revo-t-x');
  });
});
