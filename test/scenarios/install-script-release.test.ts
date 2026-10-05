import { describe, expect, it } from 'vitest';

import {
  renderInstallScript,
  type InstallScriptRelease,
} from '../../installer/render-install-script.mjs';

const checksums = {
  'linux-x64': 'a'.repeat(64),
  'linux-arm64': 'b'.repeat(64),
  'darwin-x64': 'c'.repeat(64),
  'darwin-arm64': 'd'.repeat(64),
};

const release: InstallScriptRelease = {
  channel: 'alpha',
  version: '0.1.0-alpha.1',
  releaseUrl: 'https://github.com/revisium/revo/releases/download/v0.1.0-alpha.1',
  sha256: { package: 'e'.repeat(64), lockfile: 'f'.repeat(64), workspace: '0'.repeat(64) },
  node: { version: '26.8.2', url: 'https://nodejs.org/dist/v26.8.2', sha256: checksums },
  pnpm: {
    version: '12.8.2',
    url: 'https://github.com/pnpm/pnpm/releases/download/v12.8.2',
    sha256: checksums,
  },
};

const render = (value: unknown) => () => renderInstallScript(value);

describe('install script release values', () => {
  it('renders a complete script for each channel', () => {
    const alpha = renderInstallScript(release);
    const stable = renderInstallScript({ ...release, channel: 'stable', version: '1.0.0' });

    expect(alpha).not.toContain('@@');
    expect(stable).not.toContain('@@');
    expect(alpha.trimEnd().split('\n').at(-1)).toBe('main "$@"');
  });

  it.each([
    { label: 'unknown channel', value: { ...release, channel: 'beta' } },
    { label: 'unknown field', value: { ...release, mirror: 'https://example.test' } },
    { label: 'quoted version', value: { ...release, version: "1.0.0'; rm -rf ~; '" } },
    { label: 'plain HTTP', value: { ...release, releaseUrl: 'http://example.test/v1' } },
    { label: 'quote in URL', value: { ...release, releaseUrl: "https://example.test/a'b" } },
    { label: 'trailing slash', value: { ...release, releaseUrl: 'https://example.test/v1/' } },
    {
      label: 'short checksum',
      value: { ...release, sha256: { ...release.sha256, package: 'abc' } },
    },
    {
      label: 'missing platform',
      value: {
        ...release,
        node: { ...release.node, sha256: { ...checksums, 'darwin-x64': undefined } },
      },
    },
  ])('rejects $label', ({ value }) => {
    expect(render(value)).toThrow(/^install script: /u);
  });
});
