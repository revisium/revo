#!/usr/bin/env node
// oxlint-disable no-await-in-loop -- release inputs are downloaded and written in a fixed order.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseReleaseMetadata } from '../dist/release-metadata.js';
import {
  INSTALL_PLATFORMS,
  installScriptName,
  nodeArchiveName,
  pnpmArchiveName,
  releaseAssetNames,
  renderInstallScript,
} from '../installer/render-install-script.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REVO_RELEASES = 'https://github.com/revisium/revo/releases/download';
const NODE_DIST = 'https://nodejs.org/dist';
const PNPM_RELEASES = 'https://github.com/pnpm/pnpm/releases/download';
const USAGE = `Usage: node scripts/build-release-bundle.mjs --channel stable|alpha --output DIR [--release-url URL]

Builds the flat GitHub Release assets for the checked-out package version: the package tarball,
pnpm-lock.yaml, pnpm-workspace.yaml, the channel install script and SHA256SUMS. It never publishes.
--release-url defaults to ${REVO_RELEASES}/v<version>.
`;

const fail = (message) => {
  throw new Error(`release bundle: ${message}`);
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const release = parseReleaseMetadata({
    schemaVersion: 1,
    channel: options.channel,
    version: packageJson.version,
    npm: { name: packageJson.name, distTag: options.channel === 'stable' ? 'latest' : 'alpha' },
  });
  const releaseUrl = canonicalReleaseUrl(
    options.releaseUrl ?? `${REVO_RELEASES}/v${release.version}`,
  );
  const nodeVersion = (await readFile(join(ROOT, '.nvmrc'), 'utf8')).trim();
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(packageJson.packageManager ?? '')?.[1];
  if (pnpmVersion === undefined) {
    fail('package.json must pin packageManager to an exact pnpm version');
  }
  await prepareOutput(options.output);

  const assets = releaseAssetNames(release.version);
  await packPackage(join(options.output, assets.package));
  await copyFile(join(ROOT, 'pnpm-lock.yaml'), join(options.output, assets.lockfile));
  await copyFile(join(ROOT, 'pnpm-workspace.yaml'), join(options.output, assets.workspace));
  const scriptName = installScriptName(release.channel);
  const script = renderInstallScript({
    channel: release.channel,
    version: release.version,
    releaseUrl,
    sha256: {
      package: sha256(await readFile(join(options.output, assets.package))),
      lockfile: sha256(await readFile(join(options.output, assets.lockfile))),
      workspace: sha256(await readFile(join(options.output, assets.workspace))),
    },
    node: {
      version: nodeVersion,
      url: `${NODE_DIST}/v${nodeVersion}`,
      sha256: await nodeChecksums(nodeVersion),
    },
    pnpm: {
      version: pnpmVersion,
      url: `${PNPM_RELEASES}/v${pnpmVersion}`,
      sha256: await pnpmChecksums(pnpmVersion),
    },
  });
  await writeFile(join(options.output, scriptName), script, { mode: 0o755 });
  const files = await writeChecksums(options.output);
  process.stdout.write(
    `${JSON.stringify({ channel: release.channel, version: release.version, script: scriptName, files }, null, 2)}\n`,
  );
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === '--help' || name === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (!['--channel', '--output', '--release-url'].includes(name)) {
      fail(`unknown argument ${name}`);
    }
    if (value === undefined || value.startsWith('--')) {
      fail(`missing value for ${name}`);
    }
    values.set(name, value);
  }
  if (!values.has('--channel') || !values.has('--output')) {
    fail('--channel and --output are required');
  }
  return {
    channel: values.get('--channel'),
    output: resolve(values.get('--output')),
    releaseUrl: values.get('--release-url'),
  };
}

function canonicalReleaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  const canonical = url?.pathname === '/' ? url.origin : `${url?.origin}${url?.pathname}`;
  if (
    url?.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    value.endsWith('/') ||
    canonical !== value
  ) {
    fail(
      '--release-url must be a canonical HTTPS URL without credentials, query or trailing slash',
    );
  }
  return value;
}

async function prepareOutput(output) {
  const info = await lstat(output).catch((error) => {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (info === undefined) {
    await mkdir(output, { recursive: true, mode: 0o700 });
    return;
  }
  if (!info.isDirectory() || (await readdir(output)).length > 0) {
    fail('--output must be absent or empty');
  }
}

async function packPackage(destination) {
  const stage = await mkdtemp(join(tmpdir(), 'revo-release-pack-'));
  try {
    await run('pnpm', ['pack', '--pack-destination', stage]);
    const tarballs = (await readdir(stage)).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1) {
      fail('pnpm pack must produce exactly one tarball');
    }
    const tarball = join(stage, tarballs[0]);
    const entries = (await run('tar', ['-tzf', tarball])).split('\n');
    if (
      !entries.includes('package/package.json') ||
      !entries.includes('package/dist/bin/revo.js')
    ) {
      fail('the package tarball has no built CLI; run pnpm build first');
    }
    // The temporary directory may be on another file system (tmpfs /tmp), so copy instead of rename.
    await copyFile(tarball, destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function nodeChecksums(version) {
  const listing = (await download(`${NODE_DIST}/v${version}/SHASUMS256.txt`)).toString('utf8');
  const published = new Map(
    listing
      .split('\n')
      .map((line) => /^([0-9a-f]{64}) {2}(\S+)$/u.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => [match[2], match[1]]),
  );
  return Object.fromEntries(
    INSTALL_PLATFORMS.map((platform) => {
      const checksum = published.get(nodeArchiveName(version, platform));
      if (checksum === undefined) {
        fail(`Node.js ${version} publishes no ${nodeArchiveName(version, platform)}`);
      }
      return [platform, checksum];
    }),
  );
}

async function pnpmChecksums(version) {
  const checksums = {};
  for (const platform of INSTALL_PLATFORMS) {
    checksums[platform] = sha256(
      await download(`${PNPM_RELEASES}/v${version}/${pnpmArchiveName(platform)}`),
    );
  }
  return checksums;
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    fail(`download ${url} returned HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function writeChecksums(output) {
  const files = (await readdir(output)).sort();
  const lines = [];
  for (const name of files) {
    lines.push(`${sha256(await readFile(join(output, name)))}  ${name}`);
  }
  await writeFile(join(output, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  return [...files, 'SHA256SUMS'];
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      rejectPromise(
        new Error(`release bundle: ${command} ${args.join(' ')} failed: ${stderr.trim()}`),
      );
    });
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
