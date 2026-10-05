import { readFileSync } from 'node:fs';

export const INSTALL_PLATFORMS = Object.freeze([
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
]);

const CHANNELS = Object.freeze({
  stable: { command: 'revo', product: 'Revo', script: 'install.sh' },
  alpha: { command: 'revo-alpha', product: 'Revo alpha', script: 'install-alpha.sh' },
});
const TEMPLATE = new URL('./install.sh', import.meta.url);
const PLACEHOLDER = /@@([A-Z0-9_]+)@@/gu;
const NUMBER = String.raw`(?:0|[1-9]\d*)`;
const PRERELEASE = String.raw`(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const VERSION = new RegExp(String.raw`^${NUMBER}\.${NUMBER}\.${NUMBER}${PRERELEASE}$`, 'u');
const SHA256 = /^[0-9a-f]{64}$/u;
const BASE_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~%+-]+)*$/u;
const RELEASE_KEYS = ['channel', 'node', 'pnpm', 'releaseUrl', 'sha256', 'version'];
const TOOLCHAIN_KEYS = ['sha256', 'url', 'version'];
const ASSET_KEYS = ['lockfile', 'package', 'workspace'];

export function installScriptName(channel) {
  return channelOf(channel).script;
}

export function releaseAssetNames(version) {
  return {
    package: `revo-${version}.tgz`,
    lockfile: 'pnpm-lock.yaml',
    workspace: 'pnpm-workspace.yaml',
  };
}

export function nodeArchiveName(version, platform) {
  return `node-v${version}-${platform}.tar.gz`;
}

export function pnpmArchiveName(platform) {
  return `pnpm-${platform}.tar.gz`;
}

export function renderInstallScript(release) {
  const values = scriptValues(release);
  return readFileSync(TEMPLATE, 'utf8').replaceAll(PLACEHOLDER, (_match, name) => {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`install script: unknown placeholder ${name}`);
    }
    return values[name];
  });
}

function scriptValues(release) {
  requireKeys(release, RELEASE_KEYS, 'release');
  const channel = channelOf(release.channel);
  requireKeys(release.sha256, ASSET_KEYS, 'release.sha256');
  return {
    CHANNEL: release.channel,
    PRODUCT: channel.product,
    COMMAND: channel.command,
    VERSION: matching(release.version, VERSION, 'release.version'),
    RELEASE_URL: matching(release.releaseUrl, BASE_URL, 'release.releaseUrl'),
    PACKAGE_SHA256: matching(release.sha256.package, SHA256, 'release.sha256.package'),
    LOCKFILE_SHA256: matching(release.sha256.lockfile, SHA256, 'release.sha256.lockfile'),
    WORKSPACE_SHA256: matching(release.sha256.workspace, SHA256, 'release.sha256.workspace'),
    ...toolchainValues('NODE', release.node),
    ...toolchainValues('PNPM', release.pnpm),
  };
}

function toolchainValues(prefix, toolchain) {
  const label = prefix.toLowerCase();
  requireKeys(toolchain, TOOLCHAIN_KEYS, label);
  requireKeys(toolchain.sha256, [...INSTALL_PLATFORMS].sort(byCodeUnit), `${label}.sha256`);
  const values = {
    [`${prefix}_VERSION`]: matching(toolchain.version, VERSION, `${label}.version`),
    [`${prefix}_URL`]: matching(toolchain.url, BASE_URL, `${label}.url`),
  };
  for (const platform of INSTALL_PLATFORMS) {
    const name = `${prefix}_SHA256_${platform.toUpperCase().replace('-', '_')}`;
    values[name] = matching(toolchain.sha256[platform], SHA256, `${label}.sha256.${platform}`);
  }
  return values;
}

function byCodeUnit(left, right) {
  return left < right ? -1 : Number(left > right);
}

function channelOf(channel) {
  if (!Object.hasOwn(CHANNELS, channel)) {
    throw new Error('install script: channel must be stable or alpha');
  }
  return CHANNELS[channel];
}

function requireKeys(value, keys, label) {
  const actual =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.keys(value).sort(byCodeUnit)
      : [];
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`install script: ${label} must contain exactly ${keys.join(', ')}`);
  }
}

function matching(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`install script: ${label} is invalid`);
  }
  return value;
}
