#!/usr/bin/env node
// oxlint-disable curly, no-await-in-loop, typescript/require-array-sort-compare -- release inputs are validated and written in deterministic order.

// Build an immutable, non-publishing release bundle for the POSIX installer.
// The command is intentionally opt-in: it writes only to the requested output
// directory and never changes npm, DNS, git, or a remote channel pointer.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateInstallationReleaseManifest } from '../dist/installation/release-policy.js';
import { parseReleaseMetadata } from '../dist/release-metadata.js';
import { buildInstaller } from '../installer/build-installer.mjs';
import { buildPayload } from '../installer/build-payload.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const NODE_TARGETS = [
  ['darwin', 'arm64', 'tar.gz'],
  ['darwin', 'x64', 'tar.gz'],
  ['linux', 'arm64', 'tar.xz'],
  ['linux', 'x64', 'tar.xz'],
  ['win32', 'arm64', 'zip'],
  ['win32', 'x64', 'zip'],
];
const PNPM_TARGETS = [
  ['darwin', 'arm64', 'tar.gz'],
  ['darwin', 'x64', 'tar.gz'],
  ['linux', 'arm64', 'tar.gz'],
  ['linux', 'x64', 'tar.gz'],
  ['win32', 'arm64', 'zip'],
  ['win32', 'x64', 'zip'],
];

const fail = (message) => {
  throw new Error(`release bundle: ${message}`);
};

const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const nodeArchiveName = (version, platform, arch, format) =>
  `node-v${version}-${platform === 'win32' ? 'win' : platform}-${arch}.${format}`;
const nodeArchiveUrl = (version, platform, arch, format) =>
  `https://nodejs.org/dist/v${version}/${nodeArchiveName(version, platform, arch, format)}`;
const pnpmArchiveUrl = (version, platform, arch, format) =>
  `https://github.com/pnpm/pnpm/releases/download/v${version}/pnpm-${platform}-${arch}.${format}`;

function usage() {
  process.stderr.write(
    [
      'Usage: node scripts/build-release-bundle.mjs --channel stable|alpha --origin https://host/path --output DIR',
      '',
      'The command builds and validates a private staged bundle. It never publishes.',
      'Use --skip-external-downloads only when external checksums are supplied by a reviewed process.',
    ].join('\n') + '\n',
  );
}

function argumentsOf(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--skip-external-downloads') {
      values.set('skipExternalDownloads', true);
      continue;
    }
    if (!arg.startsWith('--')) fail(`unknown argument ${arg}`);
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`missing value for --${name}`);
    values.set(name, value);
    index += 1;
  }
  const channel = values.get('channel');
  const origin = values.get('origin');
  const output = values.get('output');
  if (channel !== 'stable' && channel !== 'alpha') fail('--channel must be stable or alpha');
  if (typeof origin !== 'string' || typeof output !== 'string')
    fail('--origin and --output are required');
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    fail('--origin must be an absolute HTTPS URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    origin.endsWith('/') ||
    parsed.href !== origin
  )
    fail(
      '--origin must be a canonical HTTPS URL without credentials, query, fragment, or trailing slash',
    );
  return {
    channel,
    origin,
    output: resolve(output),
    skipExternalDownloads: values.get('skipExternalDownloads') === true,
  };
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', rejectPromise);
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`${command} ${args.join(' ')} failed: ${stderr.slice(-4096)}`));
    });
  });
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) fail(`download ${url} returned HTTP ${response.status}`);
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_DOWNLOAD_BYTES))
    fail(`download ${url} exceeds the size bound`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) fail(`download ${url} exceeds the size bound`);
  return bytes;
}

async function writeArtifact(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode: 0o600 });
}

async function assertRegularTree(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
    fail('package tarball contains a link or special file');
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await assertRegularTree(join(path, entry));
  }
}

async function prepareOutput(output) {
  try {
    const info = await lstat(output);
    if (info.isSymbolicLink() || !info.isDirectory()) fail('--output must be a directory');
    if ((info.mode & 0o077) !== 0) fail('--output must be private');
    if ((await readdir(output)).length > 0) fail('--output must be absent or empty');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(output, { recursive: true, mode: 0o700 });
  }
}

async function packageArtifact(output, packageJson) {
  const stage = await mkdtemp(join(tmpdir(), 'revo-release-pack-'));
  try {
    const packed = await run('pnpm', ['pack', '--pack-destination', stage]);
    const names = await readdir(stage);
    const tarball = names.find((name) => name.endsWith('.tgz'));
    if (tarball === undefined) fail(`pnpm pack produced no tarball: ${packed.stdout}`);
    const source = join(stage, tarball);
    const listed = await run('tar', ['-tzf', source]);
    const entries = listed.stdout.split('\n').filter(Boolean);
    if (
      entries.some((entry) => entry.startsWith('/') || entry.split('/').includes('..')) ||
      !entries.includes('package/package.json') ||
      !entries.some((entry) => entry === 'package/dist/bin/revo.js')
    )
      fail('package tarball contains an unsafe or incomplete layout');
    const listing = await run('tar', ['-tvzf', source]);
    if (
      listing.stdout
        .split('\n')
        .filter(Boolean)
        .some((line) => !['-', 'd'].includes(line[0]))
    )
      fail('package tarball contains a non-file or non-directory entry');
    const unpacked = join(stage, 'unpacked');
    await mkdir(unpacked, { mode: 0o700 });
    await run('tar', ['-xzf', source, '--no-same-owner', '--no-same-permissions', '-C', unpacked]);
    await assertRegularTree(join(unpacked, 'package'));
    const packedJsonPath = join(unpacked, 'package', 'package.json');
    const packedJson = await readFile(packedJsonPath, 'utf8');
    const packedManifest = JSON.parse(packedJson);
    if (typeof packageJson.packageManager !== 'string') fail('packageManager is not pinned');
    packedManifest.packageManager = packageJson.packageManager;
    const normalizedJson = Buffer.from(`${JSON.stringify(packedManifest, null, 2)}\n`);
    await writeFile(packedJsonPath, normalizedJson, { mode: 0o600 });
    const normalized = join(stage, 'normalized.tgz');
    await run('tar', ['-czf', normalized, '--format=ustar', '-C', unpacked, 'package']);
    const packageBytes = await readFile(normalized);
    const normalizedListing = await run('tar', ['-tzf', normalized]);
    if (!normalizedListing.stdout.split('\n').includes('package/'))
      fail('normalized package tarball omitted the package root');
    const packageJsonBytes = Buffer.from(
      (await run('tar', ['-xOzf', normalized, 'package/package.json'])).stdout,
    );
    if (packedManifest.name !== packageJson.name || packedManifest.version !== packageJson.version)
      fail('packed package metadata does not match package.json');
    const packagePath = join(output, `revo-${packageJson.version}.tgz`);
    await writeArtifact(packagePath, packageBytes);
    const packageJsonPath = join(output, 'package.json');
    await writeArtifact(packageJsonPath, packageJsonBytes);
    return { bytes: packageBytes, path: packagePath, packageJsonBytes, packageJsonPath };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function frozenInstallCheck(packageArtifactResult, output) {
  const stage = await mkdtemp(join(tmpdir(), 'revo-release-install-'));
  try {
    const packageRoot = join(stage, 'package');
    await mkdir(packageRoot, { mode: 0o700 });
    await run('tar', ['-xzf', packageArtifactResult.path, '-C', stage]);
    await cp(packageArtifactResult.packageJsonPath, join(packageRoot, 'package.json'));
    await cp(join(ROOT, 'pnpm-lock.yaml'), join(packageRoot, 'pnpm-lock.yaml'));
    await cp(join(ROOT, 'pnpm-workspace.yaml'), join(packageRoot, 'pnpm-workspace.yaml'));
    await run(
      'pnpm',
      [
        'install',
        '--prod',
        '--frozen-lockfile',
        '--store-dir',
        join(stage, 'store'),
        '--pm-on-fail=error',
        '--config.strict-dep-builds=true',
        '--config.verify-store-integrity=true',
      ],
      { cwd: packageRoot },
    );
    await writeArtifact(join(output, 'frozen-install.ok'), Buffer.from('verified\n'));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function main() {
  const options = argumentsOf(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  if (packageJson.name !== '@revisium/revo' || typeof packageJson.version !== 'string')
    fail('package.json identity is invalid');
  const release = parseReleaseMetadata({
    schemaVersion: 1,
    channel: options.channel,
    version: packageJson.version,
    npm: { name: '@revisium/revo', distTag: options.channel === 'stable' ? 'latest' : 'alpha' },
  });
  const nodeVersion = (await readFile(join(ROOT, '.nvmrc'), 'utf8')).trim();
  const pnpmVersion = /^pnpm@(.+)$/u.exec(String(packageJson.packageManager ?? ''))?.[1];
  if (!pnpmVersion) fail('packageManager must pin pnpm');
  const coreVersion = packageJson.dependencies?.['@revisium/revo-core'];
  const adminVersion = packageJson.dependencies?.['@revisium/revo-admin'];
  if (typeof coreVersion !== 'string' || typeof adminVersion !== 'string')
    fail('core/admin dependency pins are missing');
  await prepareOutput(options.output);

  const packageResult = await packageArtifact(options.output, packageJson);
  const packageJsonBytes = packageResult.packageJsonBytes;
  const lockBytes = await readFile(join(ROOT, 'pnpm-lock.yaml'));
  const workspaceBytes = await readFile(join(ROOT, 'pnpm-workspace.yaml'));
  await writeArtifact(join(options.output, 'package.json'), packageJsonBytes);
  await writeArtifact(join(options.output, 'pnpm-lock.yaml'), lockBytes);
  await writeArtifact(join(options.output, 'pnpm-workspace.yaml'), workspaceBytes);

  const releaseRoot = `${options.origin}/releases/${release.version}`;
  const artifactUrl = (name) => `${releaseRoot}/${name}`;
  const policy = {
    supportedSchemaVersions: ['revo-install/v3'],
    locators: {
      artifacts: {
        package: () => artifactUrl(`revo-${release.version}.tgz`),
        packageJson: () => artifactUrl('package.json'),
        pnpmLock: () => artifactUrl('pnpm-lock.yaml'),
        pnpmWorkspace: () => artifactUrl('pnpm-workspace.yaml'),
      },
      manifest: (version) => `${options.origin}/releases/${version}/manifest.json`,
      channel: (channel) => `${options.origin}/channels/${channel}.json`,
      nodeArchive: nodeArchiveUrl,
      nodeShasums: (version) => `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
      pnpmArchive: pnpmArchiveUrl,
    },
  };

  const nodeShasumsUrl = policy.locators.nodeShasums(nodeVersion);
  const nodeShasums = options.skipExternalDownloads
    ? await readFile(join(options.output, 'node', 'SHASUMS256.txt'))
    : await download(nodeShasumsUrl);
  await writeArtifact(join(options.output, 'node', 'SHASUMS256.txt'), nodeShasums);
  const nodeChecksums = new Map();
  for (const line of nodeShasums.toString('utf8').split('\n')) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/u.exec(line.trim());
    if (match) nodeChecksums.set(match[2], match[1]);
  }
  const nodeArchives = NODE_TARGETS.map(([platform, arch, format]) => {
    const name = nodeArchiveName(nodeVersion, platform, arch, format);
    const sha256 = nodeChecksums.get(name);
    if (sha256 === undefined) fail(`Node SHASUMS omitted ${name}`);
    return {
      platform,
      arch,
      format,
      url: nodeArchiveUrl(nodeVersion, platform, arch, format),
      sha256,
    };
  });

  const pnpmArchives = [];
  for (const [platform, arch, format] of PNPM_TARGETS) {
    const url = pnpmArchiveUrl(pnpmVersion, platform, arch, format);
    if (options.skipExternalDownloads)
      fail('--skip-external-downloads cannot verify pnpm checksums');
    const bytes = await download(url);
    const name = url.slice(url.lastIndexOf('/') + 1);
    await writeArtifact(join(options.output, 'pnpm', name), bytes);
    pnpmArchives.push({ platform, arch, format, url, sha256: hash(bytes) });
  }

  const manifest = {
    schemaVersion: 'revo-install/v3',
    release,
    components: {
      core: { name: '@revisium/revo-core', version: coreVersion },
      admin: { name: '@revisium/revo-admin', version: adminVersion },
    },
    artifacts: {
      package: {
        url: artifactUrl(`revo-${release.version}.tgz`),
        sha256: hash(packageResult.bytes),
        integrity: integrity(packageResult.bytes),
      },
      packageJson: { url: artifactUrl('package.json'), sha256: hash(packageJsonBytes) },
      pnpmLock: { url: artifactUrl('pnpm-lock.yaml'), sha256: hash(lockBytes) },
      pnpmWorkspace: { url: artifactUrl('pnpm-workspace.yaml'), sha256: hash(workspaceBytes) },
    },
    toolchain: {
      node: nodeVersion,
      pnpm: pnpmVersion,
      nodeArchives,
      nodeShasums: { url: nodeShasumsUrl, sha256: hash(nodeShasums) },
      pnpmArchives,
    },
  };
  validateInstallationReleaseManifest(manifest, policy);
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const channelBytes = Buffer.from(JSON.stringify(release, null, 2) + '\n');
  await writeArtifact(join(options.output, 'manifest.json'), manifestBytes);
  await writeArtifact(join(options.output, 'channel.json'), channelBytes);

  const payload = await buildPayload();
  const template = await readFile(join(ROOT, 'installer', 'install.sh.in'), 'utf8');
  const installer = buildInstaller({
    manifest,
    policy,
    bootstrapPolicy: {
      schemaVersion: 'revo-node-bootstrap/v1',
      downloadTimeoutSeconds: 60,
      nodeProbeTimeoutSeconds: 20,
      payloadTimeoutSeconds: 300,
      terminationGraceSeconds: 10,
      targets: NODE_TARGETS.map(([platform, arch, format]) => ({ platform, arch, format })),
    },
    template,
    payload,
  });
  const installerPath = join(options.output, 'install.sh');
  const installerBytes = Buffer.from(installer);
  await writeArtifact(installerPath, installerBytes);
  await chmod(installerPath, 0o700);
  await frozenInstallCheck(packageResult, options.output);
  const report = {
    schemaVersion: 'revo-release-bundle/v1',
    status: 'verified',
    origin: options.origin,
    release,
    components: manifest.components,
    toolchain: {
      node: nodeVersion,
      pnpm: pnpmVersion,
    },
    artifacts: {
      package: hash(packageResult.bytes),
      packageJson: hash(packageJsonBytes),
      pnpmLock: hash(lockBytes),
      pnpmWorkspace: hash(workspaceBytes),
      manifest: hash(manifestBytes),
      channel: hash(channelBytes),
      installer: hash(installerBytes),
    },
  };
  await writeArtifact(
    join(options.output, 'release-bundle-report.json'),
    Buffer.from(JSON.stringify(report, null, 2) + '\n'),
  );
  await writeArtifact(join(options.output, 'release-bundle.ok'), Buffer.from('verified\n'));

  const files = [];
  const walk = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = join(prefix, entry.name);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, relative);
      else if (entry.isFile()) files.push(relative);
    }
  };
  await walk(options.output);
  const sums = [];
  for (const relative of files.sort()) {
    if (relative === 'SHA256SUMS') continue;
    sums.push(`${hash(await readFile(join(options.output, relative)))}  ${relative}`);
  }
  await writeArtifact(join(options.output, 'SHA256SUMS'), Buffer.from(sums.join('\n') + '\n'));
  process.stdout.write(
    JSON.stringify(
      {
        channel: release.channel,
        version: release.version,
        output: options.output,
        installer: installerPath,
        manifest: join(options.output, 'manifest.json'),
        artifactCount: files.length,
        frozenInstall: 'verified',
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
