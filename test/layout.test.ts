import { describe, expect, it } from 'vitest';

import { resolveRevoLayout, type RevoLayout } from '../src/layout.js';

function layoutDirectories(layout: RevoLayout): string[] {
  return [layout.configDir, layout.dataDir, layout.stateDir, layout.cacheDir, layout.runtimeDir];
}

describe('resolveRevoLayout', () => {
  it('uses XDG directories on Linux', () => {
    expect(
      resolveRevoLayout({
        channel: 'stable',
        env: {
          XDG_CACHE_HOME: '/xdg/cache',
          XDG_CONFIG_HOME: '/xdg/config',
          XDG_DATA_HOME: '/xdg/data',
          XDG_RUNTIME_DIR: '/run/user/1000',
          XDG_STATE_HOME: '/xdg/state',
        },
        homeDir: '/home/revo',
        platform: 'linux',
      }),
    ).toEqual({
      cacheDir: '/xdg/cache/revo',
      channel: 'stable',
      configDir: '/xdg/config/revo',
      dataDir: '/xdg/data/revo',
      runtimeDir: '/run/user/1000/revo',
      stateDir: '/xdg/state/revo',
    });
  });

  it('uses conventional macOS directories', () => {
    expect(
      resolveRevoLayout({ channel: 'alpha', env: {}, homeDir: '/Users/revo', platform: 'darwin' }),
    ).toEqual({
      cacheDir: '/Users/revo/Library/Caches/Revo Alpha',
      channel: 'alpha',
      configDir: '/Users/revo/Library/Application Support/Revo Alpha/config',
      dataDir: '/Users/revo/Library/Application Support/Revo Alpha/data',
      runtimeDir: '/Users/revo/Library/Application Support/Revo Alpha/state/run',
      stateDir: '/Users/revo/Library/Application Support/Revo Alpha/state',
    });
  });

  it('uses injected Windows directories with Windows separators', () => {
    expect(
      resolveRevoLayout({
        channel: 'stable',
        env: { APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local' },
        homeDir: 'C:\\Users\\revo',
        platform: 'win32',
      }),
    ).toEqual({
      cacheDir: 'D:\\Local\\Revisium\\Revo\\cache',
      channel: 'stable',
      configDir: 'D:\\Roaming\\Revisium\\Revo\\config',
      dataDir: 'D:\\Local\\Revisium\\Revo\\data',
      runtimeDir: 'D:\\Local\\Revisium\\Revo\\state\\run',
      stateDir: 'D:\\Local\\Revisium\\Revo\\state',
    });
  });

  it('treats every empty XDG base directory as unset', () => {
    expect(
      resolveRevoLayout({
        channel: 'stable',
        env: {
          XDG_CACHE_HOME: '',
          XDG_CONFIG_HOME: '',
          XDG_DATA_HOME: '',
          XDG_STATE_HOME: '',
        },
        homeDir: '/home/revo',
        platform: 'linux',
      }),
    ).toMatchObject({
      cacheDir: '/home/revo/.cache/revo',
      configDir: '/home/revo/.config/revo',
      dataDir: '/home/revo/.local/share/revo',
      stateDir: '/home/revo/.local/state/revo',
    });
  });

  it('treats both empty Windows base directories as unset', () => {
    expect(
      resolveRevoLayout({
        channel: 'alpha',
        env: { APPDATA: '', LOCALAPPDATA: '' },
        homeDir: 'C:\\Users\\revo',
        platform: 'win32',
      }),
    ).toMatchObject({
      cacheDir: 'C:\\Users\\revo\\AppData\\Local\\Revisium\\Revo Alpha\\cache',
      configDir: 'C:\\Users\\revo\\AppData\\Roaming\\Revisium\\Revo Alpha\\config',
      dataDir: 'C:\\Users\\revo\\AppData\\Local\\Revisium\\Revo Alpha\\data',
      stateDir: 'C:\\Users\\revo\\AppData\\Local\\Revisium\\Revo Alpha\\state',
    });
  });

  it.each([
    { env: {}, homeDir: '/home/revo', platform: 'linux' as const },
    { env: {}, homeDir: '/Users/revo', platform: 'darwin' as const },
    { env: {}, homeDir: 'C:\\Users\\revo', platform: 'win32' as const },
  ])('keeps all stable and alpha directories separate on $platform', (input) => {
    const stable = resolveRevoLayout({ ...input, channel: 'stable' });
    const alpha = resolveRevoLayout({ ...input, channel: 'alpha' });
    const separator = input.platform === 'win32' ? '\\' : '/';

    for (const stableDirectory of layoutDirectories(stable)) {
      for (const alphaDirectory of layoutDirectories(alpha)) {
        expect(stableDirectory).not.toBe(alphaDirectory);
        expect(stableDirectory.startsWith(`${alphaDirectory}${separator}`)).toBe(false);
        expect(alphaDirectory.startsWith(`${stableDirectory}${separator}`)).toBe(false);
      }
    }
  });

  it.each(['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'])(
    'rejects a nonempty relative Linux %s',
    (variable) => {
      expect(() =>
        resolveRevoLayout({
          channel: 'stable',
          env: { [variable]: 'relative/path' },
          homeDir: '/home/revo',
          platform: 'linux',
        }),
      ).toThrow(`${variable} must be an absolute path`);
    },
  );

  it.each(['APPDATA', 'LOCALAPPDATA'])('rejects a nonempty relative Windows %s', (variable) => {
    expect(() =>
      resolveRevoLayout({
        channel: 'stable',
        env: { [variable]: 'relative\\path' },
        homeDir: 'C:\\Users\\revo',
        platform: 'win32',
      }),
    ).toThrow(`${variable} must be an absolute path`);
  });
});
