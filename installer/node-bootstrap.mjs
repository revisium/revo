// oxlint-disable curly, no-await-in-loop -- self-contained installer payload keeps guarded operations compact

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  open,
  readFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HASH = /^[a-f0-9]{64}$/u;
const VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SCHEMA = 'revo-node-bootstrap/v1';
const TARGETS = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'arm64'],
  ['linux', 'x64'],
  ['win32', 'arm64'],
  ['win32', 'x64'],
];
const archiveTargets = (node) =>
  TARGETS.map(([platform, arch]) => [
    platform,
    arch,
    platform === 'win32' ? 'zip' : node && platform === 'linux' ? 'tar.xz' : 'tar.gz',
  ]);
const NODE_TARGETS = archiveTargets(true);
const PNPM_TARGETS = archiveTargets(false);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_LIMIT = 512 * 1024 * 1024;
export const PNPM_PROGRESS_STAGES = Object.freeze([
  'validate',
  'download',
  'verify',
  'extract',
  'probe',
  'publish',
  'reuse',
]);
export const DEFAULT_PNPM_POLICY = Object.freeze({
  downloadTimeoutMs: 60_000,
  extractTimeoutMs: 120_000,
  probeTimeoutMs: 30_000,
  terminationGraceMs: 5_000,
  redirectLimit: 2,
  maxDownloadBytes: DEFAULT_LIMIT,
  maxOutputBytes: 4_096,
});
const ARCHIVE_KEYS = ['arch', 'format', 'platform', 'sha256', 'url'];
const EXECUTION_KEYS = [
  'downloadTimeoutSeconds',
  'nodeProbeTimeoutSeconds',
  'payloadTimeoutSeconds',
  'terminationGraceSeconds',
];
const V2_KEYS = ['archives', 'execution', 'nodeVersion', 'schemaVersion', 'snapshot'];
const V3_KEYS = [...V2_KEYS, 'channel', 'pnpmArchives', 'pnpmVersion'];
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value, keys) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const fail = (message) => {
  throw new Error(`Invalid Node bootstrap data: ${message}`);
};
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const identity = (platform, arch, format) => `${platform}/${arch}/${format}`;
const pnpmUrl = (version, platform, arch, format) =>
  `https://github.com/pnpm/pnpm/releases/download/v${version}/pnpm-${platform}-${arch}.${format}`;
const nodeUrlShape = (url) => /^https:\/\/(?![^/?#]*@)[^/?#]+(?:\/[^?#]*)?$/u.test(url);

function descriptor(value, targets, label, version, canonical) {
  if (!record(value) || !exact(value, ARCHIVE_KEYS)) fail(`${label} descriptor fields`);
  if (
    typeof value.platform !== 'string' ||
    typeof value.arch !== 'string' ||
    typeof value.format !== 'string' ||
    typeof value.url !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !HASH.test(value.sha256)
  )
    fail(`${label} descriptor types`);
  if (
    !targets.some(
      ([platform, arch, format]) =>
        value.platform === platform && value.arch === arch && value.format === format,
    )
  )
    fail(`${label} target or format`);
  const expected =
    canonical.length === 1
      ? canonical(value.url)
      : value.url === canonical(version, value.platform, value.arch, value.format);
  if (!expected) fail(`${label} URL is not canonical`);
  return {
    platform: value.platform,
    arch: value.arch,
    format: value.format,
    url: value.url,
    sha256: value.sha256,
  };
}

function descriptors(value, targets, label, version, canonical) {
  if (!Array.isArray(value) || value.length !== targets.length) fail(`${label} archive set length`);
  const result = value.map((item) => descriptor(item, targets, label, version, canonical));
  const identities = result.map(({ platform, arch, format }) => identity(platform, arch, format));
  if (
    new Set(identities).size !== identities.length ||
    !targets.every((target) => identities.includes(identity(...target)))
  )
    fail(`${label} target set`);
  return result;
}

/** Purely decode the literal bootstrap; it performs no filesystem or network IO. */
export function decodeBootstrap(value, options) {
  if (
    !record(options) ||
    !exact(options, ['arch', 'nodeVersion', 'platform']) ||
    typeof options.platform !== 'string' ||
    typeof options.arch !== 'string' ||
    typeof options.nodeVersion !== 'string' ||
    !VERSION.test(options.nodeVersion)
  )
    fail('target options');
  if (
    !NODE_TARGETS.some(([platform, arch]) => platform === options.platform && arch === options.arch)
  )
    fail('unsupported target');
  if (!record(value)) fail('top-level value');
  const v3 = Object.prototype.hasOwnProperty.call(value, 'pnpmArchives');
  if (
    value.schemaVersion !== SCHEMA ||
    !exact(value, v3 ? V3_KEYS : V2_KEYS) ||
    typeof value.nodeVersion !== 'string' ||
    !VERSION.test(value.nodeVersion) ||
    value.nodeVersion !== options.nodeVersion
  )
    fail('schema or Node version');
  if (
    !record(value.execution) ||
    !exact(value.execution, EXECUTION_KEYS) ||
    !EXECUTION_KEYS.every((key) => positive(value.execution[key]))
  )
    fail('execution policy');
  if (
    !record(value.snapshot) ||
    !exact(value.snapshot, ['sha256', 'url']) ||
    typeof value.snapshot.url !== 'string' ||
    typeof value.snapshot.sha256 !== 'string' ||
    !HASH.test(value.snapshot.sha256) ||
    value.snapshot.url !== `https://nodejs.org/dist/v${value.nodeVersion}/SHASUMS256.txt`
  )
    fail('checksum snapshot');
  const nodeArchives = descriptors(
    value.archives,
    NODE_TARGETS,
    'Node',
    value.nodeVersion,
    nodeUrlShape,
  );
  const nodeArchive = nodeArchives.find(
    (archive) => archive.platform === options.platform && archive.arch === options.arch,
  );
  if (nodeArchive === undefined) fail('selected Node target');
  if (!v3) return { bootstrap: value, nodeArchive, pnpmArchive: undefined };
  if (
    (value.channel !== 'stable' && value.channel !== 'alpha') ||
    typeof value.pnpmVersion !== 'string' ||
    !VERSION.test(value.pnpmVersion)
  )
    fail('pnpm version or channel');
  const pnpmArchives = descriptors(
    value.pnpmArchives,
    PNPM_TARGETS,
    'pnpm',
    value.pnpmVersion,
    pnpmUrl,
  );
  const pnpmArchive = pnpmArchives.find(
    (archive) => archive.platform === options.platform && archive.arch === options.arch,
  );
  if (
    pnpmArchive === undefined ||
    pnpmArchive.format !== (options.platform === 'win32' ? 'zip' : 'tar.gz')
  )
    fail('selected pnpm target');
  return { bootstrap: value, nodeArchive, pnpmArchive };
}

const acquisitionFailure = (stage, reason) => new Error(`pnpm ${stage}: ${reason}`);
const policyFor = (value = {}) => {
  if (!record(value)) throw acquisitionFailure('validate', 'policy must be an object');
  const policy = { ...DEFAULT_PNPM_POLICY, ...value };
  for (const key of [
    'downloadTimeoutMs',
    'extractTimeoutMs',
    'probeTimeoutMs',
    'terminationGraceMs',
    'maxOutputBytes',
  ])
    if (!positive(policy[key]) || policy[key] > 600_000)
      throw acquisitionFailure('validate', `policy.${key} is unbounded`);
  if (!positive(policy.maxDownloadBytes) || policy.maxDownloadBytes > DEFAULT_LIMIT)
    throw acquisitionFailure('validate', 'policy.maxDownloadBytes is unbounded');
  if (
    !Number.isSafeInteger(policy.redirectLimit) ||
    policy.redirectLimit < 0 ||
    policy.redirectLimit > 5
  )
    throw acquisitionFailure('validate', 'policy.redirectLimit is unbounded');
  return policy;
};
const boundedText = (value, limit) =>
  String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .slice(0, limit);
const header = (response, name) => response.headers?.get?.(name) ?? response.headers?.[name];
const dispose = async (response) => {
  try {
    await response?.body?.cancel?.();
  } catch {
    /* body disposal is best effort */
  }
};

async function downloadPnpm(url, destination, policy, signal, request) {
  let initial;
  try {
    initial = new URL(url);
  } catch {
    throw acquisitionFailure('download', 'archive URL is invalid');
  }
  if (
    initial.protocol !== 'https:' ||
    initial.hostname !== 'github.com' ||
    initial.username ||
    initial.password ||
    initial.hash ||
    initial.search
  )
    throw acquisitionFailure('download', 'archive URL is not canonical GitHub');
  const fetcher = request ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw acquisitionFailure('download', 'request is unavailable');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), policy.downloadTimeoutMs);
  let current = initial.href;
  let redirects = 0;
  try {
    let response;
    for (;;) {
      if (controller.signal.aborted)
        throw acquisitionFailure('download', signal?.aborted ? 'cancelled' : 'timed out');
      try {
        const pending = Promise.resolve().then(() =>
          fetcher(current, { redirect: 'manual', signal: controller.signal }),
        );
        response = await new Promise((resolveResponse, rejectResponse) => {
          const cancel = () => rejectResponse(acquisitionFailure('download', 'request aborted'));
          controller.signal.addEventListener('abort', cancel, { once: true });
          pending.then(
            (value) => {
              controller.signal.removeEventListener('abort', cancel);
              resolveResponse(value);
            },
            (error) => {
              controller.signal.removeEventListener('abort', cancel);
              rejectResponse(error);
            },
          );
        });
      } catch {
        throw acquisitionFailure(
          'download',
          controller.signal.aborted
            ? signal?.aborted
              ? 'cancelled'
              : 'timed out'
            : 'request failed',
        );
      }
      if (response === undefined || typeof response.status !== 'number') {
        throw acquisitionFailure('download', 'request returned no response');
      }
      if (!REDIRECTS.has(response.status)) break;
      if (redirects++ >= policy.redirectLimit) {
        await dispose(response);
        throw acquisitionFailure('download', 'redirect limit exceeded');
      }
      const location = header(response, 'location');
      if (typeof location !== 'string' || location === '') {
        await dispose(response);
        throw acquisitionFailure('download', 'redirect location is missing');
      }
      let next;
      try {
        next = new URL(location, current);
      } catch {
        await dispose(response);
        throw acquisitionFailure('download', 'redirect target is invalid');
      }
      const from = new URL(current);
      if (
        next.protocol !== 'https:' ||
        next.hostname !== 'release-assets.githubusercontent.com' ||
        next.username ||
        next.password ||
        next.hash ||
        !next.search ||
        (from.href !== initial.href && from.hostname !== next.hostname)
      ) {
        await dispose(response);
        throw acquisitionFailure('download', 'redirect target is not allowed');
      }
      await dispose(response);
      current = next.href;
    }
    if (response.status !== 200) {
      await dispose(response);
      throw acquisitionFailure('download', `HTTP ${String(response.status)}`);
    }
    const rawLength = header(response, 'content-length');
    const length =
      rawLength === undefined || rawLength === null || rawLength === ''
        ? undefined
        : Number(rawLength);
    if (
      length !== undefined &&
      (!Number.isSafeInteger(length) || length < 0 || length > policy.maxDownloadBytes)
    ) {
      await dispose(response);
      throw acquisitionFailure('download', 'archive exceeds size bound');
    }
    const chunks = [];
    let bytes = 0;
    try {
      if (response.body?.[Symbol.asyncIterator] !== undefined) {
        for await (const chunk of response.body) {
          if (controller.signal.aborted)
            throw acquisitionFailure('download', signal?.aborted ? 'cancelled' : 'timed out');
          const data = Buffer.from(chunk);
          bytes += data.length;
          if (bytes > policy.maxDownloadBytes)
            throw acquisitionFailure('download', 'archive exceeds size bound');
          chunks.push(data);
        }
      } else if (typeof response.arrayBuffer === 'function') {
        const data = Buffer.from(await response.arrayBuffer());
        bytes = data.length;
        if (bytes > policy.maxDownloadBytes)
          throw acquisitionFailure('download', 'archive exceeds size bound');
        chunks.push(data);
      } else throw acquisitionFailure('download', 'response body is missing');
    } catch (error) {
      await dispose(response);
      if (error instanceof Error && error.message.startsWith('pnpm ')) throw error;
      throw acquisitionFailure(
        'download',
        controller.signal.aborted ? (signal?.aborted ? 'cancelled' : 'timed out') : 'body failed',
      );
    }
    if (controller.signal.aborted)
      throw acquisitionFailure('download', signal?.aborted ? 'cancelled' : 'timed out');
    if (length !== undefined && bytes !== length)
      throw acquisitionFailure('download', 'response was truncated');
    const data = Buffer.concat(chunks);
    const archiveSha256 = createHash('sha256').update(data).digest('hex');
    const file = await open(destination, 'wx', 0o600);
    try {
      await file.writeFile(data);
    } finally {
      await file.close();
    }
    return archiveSha256;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function runProcess(command, args, stage, timeoutMs, policy, signal) {
  return new Promise((done, reject) => {
    if (signal?.aborted) {
      reject(acquisitionFailure(stage, 'cancelled'));
      return;
    }
    let child;
    try {
      child = spawn(command, args, {
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      reject(acquisitionFailure(stage, 'process could not start'));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += boundedText(chunk, policy.maxOutputBytes - stdout.length);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += boundedText(chunk, policy.maxOutputBytes - stderr.length);
    });
    let stopping = false;
    let timedOut = false;
    let grace;
    const kill = (name) => {
      try {
        if (child.pid === undefined) child.kill(name);
        else process.kill(-child.pid, name);
      } catch {
        try {
          child.kill(name);
        } catch {
          /* exited */
        }
      }
    };
    const stop = (timeout) => {
      if (stopping) return;
      stopping = true;
      timedOut = timeout;
      kill('SIGTERM');
      grace = setTimeout(() => kill('SIGKILL'), policy.terminationGraceMs);
    };
    const timer = setTimeout(() => stop(true), timeoutMs);
    const abort = () => stop(false);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', () => {});
    child.once('close', (code, term) => {
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(acquisitionFailure(stage, 'cancelled'));
      else if (timedOut) reject(acquisitionFailure(stage, 'timed out'));
      else if (code !== 0)
        reject(acquisitionFailure(stage, `process failed${term ? ` (${term})` : ''}: ${stderr}`));
      else done(stdout);
    });
  });
}

const runTar = (archive, stage, policy, signal) =>
  runProcess(
    'tar',
    ['-xzf', archive, '-C', stage],
    'extract',
    policy.extractTimeoutMs,
    policy,
    signal,
  );

async function safeLayout(root) {
  const walk = async (path) => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw acquisitionFailure('extract', 'archive contains a symlink');
    if (info.isDirectory()) for (const child of await readdir(path)) await walk(join(path, child));
  };
  await walk(root);
  const executable = join(root, 'pnpm');
  const pnpm = await lstat(executable).catch(() => undefined);
  const dist = await lstat(join(root, 'dist')).catch(() => undefined);
  if (
    pnpm === undefined ||
    !pnpm.isFile() ||
    (pnpm.mode & 0o111) === 0 ||
    dist === undefined ||
    !dist.isDirectory()
  )
    throw acquisitionFailure('extract', 'archive has no safe pnpm+dist layout');
  return executable;
}

/** Acquire the verified v3 pnpm archive into an owned temporary directory. */
export async function acquirePnpmArtifact({
  bootstrap,
  platform,
  arch,
  scratch,
  policy: inputPolicy,
  signal,
  request,
  onProgress,
} = {}) {
  if (platform === 'win32')
    throw acquisitionFailure('validate', 'Windows pnpm acquisition is unsupported');
  if (!TARGETS.some(([itemPlatform, itemArch]) => itemPlatform === platform && itemArch === arch))
    throw acquisitionFailure('validate', 'unsupported target');
  if (signal?.aborted) throw acquisitionFailure('validate', 'cancelled');
  const policy = policyFor(inputPolicy);
  if (typeof scratch !== 'string' || scratch.includes('\0') || !isAbsolute(scratch))
    throw acquisitionFailure('validate', 'scratch must be absolute');
  const scratchInfo = await lstat(scratch).catch(() => undefined);
  if (scratchInfo === undefined || !scratchInfo.isDirectory() || scratchInfo.isSymbolicLink())
    throw acquisitionFailure('validate', 'scratch must be an owned directory');
  const decoded =
    record(bootstrap) &&
    record(bootstrap.bootstrap) &&
    (bootstrap.nodeArchive !== undefined || bootstrap.pnpmArchive !== undefined)
      ? bootstrap
      : decodeBootstrap(bootstrap, { platform, arch, nodeVersion: process.versions.node });
  if (decoded.pnpmArchive === undefined)
    throw acquisitionFailure('validate', 'v3 pnpm archive is required');
  const stage = await mkdtemp(join(scratch, '.pnpm-stage-'));
  let transferred = false;
  try {
    onProgress?.('download');
    const archivePath = join(stage, 'pnpm.tar.gz');
    const found = await downloadPnpm(decoded.pnpmArchive.url, archivePath, policy, signal, request);
    onProgress?.('verify');
    if (found !== decoded.pnpmArchive.sha256)
      throw acquisitionFailure('verify', 'archive checksum mismatch');
    onProgress?.('extract');
    await runTar(archivePath, stage, policy, signal);
    await rm(archivePath, { force: true });
    const executablePath = await safeLayout(stage);
    transferred = true;
    return {
      directory: stage,
      executablePath,
      version: decoded.bootstrap.pnpmVersion,
      archiveSha256: found,
    };
  } finally {
    if (!transferred) await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

const absolutePath = (value, name) => {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value))
    throw acquisitionFailure('validate', `${name} must be absolute`);
  return resolve(value);
};
async function privateNode(nodeExecutable, scratch, privateNodeRoot = scratch) {
  const nodePath = absolutePath(nodeExecutable, 'nodeExecutable');
  const scratchPath = absolutePath(scratch, 'scratch');
  const rootPath = absolutePath(privateNodeRoot, 'privateNodeRoot');
  const [nodeInfo, scratchInfo, rootInfo, nodeReal, scratchReal, rootReal] = await Promise.all([
    lstat(nodePath).catch(() => undefined),
    lstat(scratchPath).catch(() => undefined),
    lstat(rootPath).catch(() => undefined),
    realpath(nodePath).catch(() => undefined),
    realpath(scratchPath).catch(() => undefined),
    realpath(rootPath).catch(() => undefined),
  ]);
  if (
    nodeInfo === undefined ||
    !nodeInfo.isFile() ||
    nodeInfo.isSymbolicLink() ||
    (nodeInfo.mode & 0o111) === 0 ||
    scratchInfo === undefined ||
    !scratchInfo.isDirectory() ||
    scratchInfo.isSymbolicLink() ||
    rootInfo === undefined ||
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    nodeReal === undefined ||
    scratchReal === undefined ||
    rootReal === undefined ||
    relative(rootReal, nodeReal).startsWith('..') ||
    isAbsolute(relative(rootReal, nodeReal))
  )
    throw acquisitionFailure('validate', 'private Node is not a safe executable in root');
  return { nodePath, scratchPath };
}
async function targetParents(target, root) {
  const base = absolutePath(root, 'channelRoot');
  const baseInfo = await lstat(base).catch(() => undefined);
  if (baseInfo === undefined || !baseInfo.isDirectory() || baseInfo.isSymbolicLink())
    throw acquisitionFailure('validate', 'channelRoot is unsafe');
  const suffix = relative(base, dirname(target));
  if (suffix.startsWith('..') || isAbsolute(suffix))
    throw acquisitionFailure('validate', 'target escapes channelRoot');
  let current = base;
  for (const part of suffix.split('/').filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (info !== undefined && (!info.isDirectory() || info.isSymbolicLink()))
      throw acquisitionFailure('validate', 'target ancestor is unsafe');
    if (info === undefined) await mkdir(current, { mode: 0o700 });
  }
}
const pnpmReceipt = (bootstrap, archive, platform, arch) => ({
  schemaVersion: 'revo-pnpm-bootstrap/v1',
  version: bootstrap.pnpmVersion,
  nodeVersion: bootstrap.nodeVersion,
  platform,
  arch,
  archiveSha256: archive.sha256,
});
async function existingTarget(target, expected, policy, signal) {
  const info = await lstat(target).catch(() => undefined);
  if (info === undefined) return undefined;
  if (!info.isDirectory() || info.isSymbolicLink())
    throw acquisitionFailure('reuse', 'target is unsafe');
  const executablePath = await safeLayout(target);
  const receiptPath = join(target, 'install-receipt.json');
  const receiptInfo = await lstat(receiptPath).catch(() => undefined);
  if (
    receiptInfo === undefined ||
    !receiptInfo.isFile() ||
    receiptInfo.isSymbolicLink() ||
    (receiptInfo.mode & 0o777) !== 0o600
  )
    throw acquisitionFailure('reuse', 'receipt is unsafe');
  let found;
  try {
    found = JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch {
    throw acquisitionFailure('reuse', 'receipt is corrupt');
  }
  if (
    !record(found) ||
    Object.keys(found).length !== Object.keys(expected).length ||
    JSON.stringify(found) !== JSON.stringify(expected)
  )
    throw acquisitionFailure('reuse', 'receipt is incompatible');
  const output = await runProcess(
    executablePath,
    ['--version'],
    'probe',
    policy.probeTimeoutMs,
    policy,
    signal,
  );
  if (output.trim() !== expected.version)
    throw acquisitionFailure('probe', 'pnpm version does not match');
  return executablePath;
}

/** Publish or reuse one managed pnpm target; the caller owns any channel lock. */
export async function provisionPnpm({
  bootstrap,
  nodeExecutable,
  channelRoot,
  scratch,
  platform,
  arch,
  policy: inputPolicy,
  signal,
  request,
  onProgress,
  privateNodeRoot,
} = {}) {
  if (platform === 'win32')
    throw acquisitionFailure('validate', 'Windows pnpm provisioning is unsupported');
  if (!TARGETS.some(([itemPlatform, itemArch]) => itemPlatform === platform && itemArch === arch))
    throw acquisitionFailure('validate', 'unsupported target');
  if (signal?.aborted) throw acquisitionFailure('validate', 'cancelled');
  const policy = policyFor(inputPolicy);
  const { scratchPath } = await privateNode(nodeExecutable, scratch, privateNodeRoot);
  const decoded =
    record(bootstrap) &&
    record(bootstrap.bootstrap) &&
    (bootstrap.nodeArchive !== undefined || bootstrap.pnpmArchive !== undefined)
      ? bootstrap
      : decodeBootstrap(bootstrap, { platform, arch, nodeVersion: process.versions.node });
  if (decoded.pnpmArchive === undefined)
    throw acquisitionFailure('validate', 'v3 pnpm archive is required');
  const root = absolutePath(channelRoot, 'channelRoot');
  const target = join(
    root,
    'pnpm',
    decoded.bootstrap.nodeVersion,
    `${platform}-${arch}`,
    decoded.bootstrap.pnpmVersion,
  );
  await targetParents(target, root);
  onProgress?.('validate');
  const expected = pnpmReceipt(decoded.bootstrap, decoded.pnpmArchive, platform, arch);
  const reused = await existingTarget(target, expected, policy, signal);
  if (reused !== undefined) {
    onProgress?.('probe');
    onProgress?.('reuse');
    return { executablePath: reused, version: decoded.bootstrap.pnpmVersion, reused: true };
  }
  const acquired = await acquirePnpmArtifact({
    bootstrap: decoded,
    platform,
    arch,
    scratch: scratchPath,
    policy,
    signal,
    request,
    onProgress,
  });
  let published = false;
  try {
    const output = await runProcess(
      join(acquired.directory, 'pnpm'),
      ['--version'],
      'probe',
      policy.probeTimeoutMs,
      policy,
      signal,
    );
    if (output.trim() !== decoded.bootstrap.pnpmVersion)
      throw acquisitionFailure('probe', 'pnpm version does not match');
    onProgress?.('probe');
    const receiptPath = join(acquired.directory, 'install-receipt.json');
    const file = await open(receiptPath, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(expected)}\n`, 'utf8');
    } finally {
      await file.close();
    }
    const appeared = await lstat(target).catch(() => undefined);
    if (appeared !== undefined)
      throw acquisitionFailure('publish', 'target appeared before publication');
    try {
      await rename(acquired.directory, target);
    } catch (error) {
      if (error?.code === 'EXDEV')
        throw acquisitionFailure('publish', 'atomic rename crossed filesystems');
      throw acquisitionFailure('publish', 'atomic rename failed');
    }
    published = true;
  } finally {
    if (!published) await rm(acquired.directory, { recursive: true, force: true }).catch(() => {});
  }
  onProgress?.('publish');
  return {
    executablePath: join(target, 'pnpm'),
    version: decoded.bootstrap.pnpmVersion,
    reused: false,
  };
}

function targetParts(target) {
  if (typeof target !== 'string') fail('target input');
  const match = /^(darwin|linux|win32)-(arm64|x64)$/u.exec(target);
  if (match?.[1] === undefined || match[2] === undefined) fail('target input');
  return { platform: match[1], arch: match[2] };
}

/** Verify the existing staged Node and write one exact, exclusive receipt. */
export async function runBootstrap({ dataPath, receiptPath, target, archiveSha256 } = {}) {
  if (
    typeof dataPath !== 'string' ||
    typeof receiptPath !== 'string' ||
    typeof target !== 'string' ||
    typeof archiveSha256 !== 'string'
  )
    throw new Error('Node bootstrap input is incomplete.');
  const parts = targetParts(target);
  const value = JSON.parse(await readFile(dataPath, 'utf8'));
  const decoded = decodeBootstrap(value, { ...parts, nodeVersion: process.versions.node });
  if (process.versions.node !== decoded.bootstrap.nodeVersion)
    throw new Error('Node bootstrap runtime version does not match the data.');
  if (decoded.nodeArchive.sha256 !== archiveSha256)
    throw new Error('Node bootstrap archive checksum does not match the data.');
  const receipt = `${JSON.stringify({ version: decoded.bootstrap.nodeVersion, target, archiveSha256 })}\n`;
  const file = await open(receiptPath, 'wx', 0o600);
  try {
    await file.writeFile(receipt, 'utf8');
  } finally {
    await file.close();
  }
  return decoded;
}

/** Run the v3 handoff from the executing private Node; the caller owns the channel lock. */
export async function runInstallMode({
  dataPath,
  receiptPath,
  target,
  archiveSha256,
  channelRoot,
  privateNodeRoot,
  scratch,
  policy,
  signal,
  request,
  onProgress,
} = {}) {
  if (
    [dataPath, receiptPath, target, archiveSha256, channelRoot, privateNodeRoot, scratch].some(
      (value) => typeof value !== 'string',
    )
  )
    throw new Error('Node install handoff input is incomplete.');
  const parts = targetParts(target);
  const value = JSON.parse(await readFile(dataPath, 'utf8'));
  const decoded = decodeBootstrap(value, { ...parts, nodeVersion: process.versions.node });
  if (decoded.pnpmArchive === undefined)
    throw acquisitionFailure('validate', 'v3 install mode requires pnpm data');
  if (decoded.nodeArchive.sha256 !== archiveSha256)
    throw new Error('Node bootstrap archive checksum does not match the data.');
  const nodeExecutable = process.execPath;
  const result = await provisionPnpm({
    bootstrap: decoded,
    nodeExecutable,
    privateNodeRoot,
    channelRoot,
    scratch,
    platform: parts.platform,
    arch: parts.arch,
    policy,
    signal,
    request,
    onProgress,
  });
  const receipt = `${JSON.stringify({ version: decoded.bootstrap.nodeVersion, target, archiveSha256 })}\n`;
  const receiptInfo = await lstat(receiptPath).catch(() => undefined);
  if (receiptInfo === undefined) {
    const file = await open(receiptPath, 'wx', 0o600);
    try {
      await file.writeFile(receipt, 'utf8');
    } finally {
      await file.close();
    }
  } else if (
    !receiptInfo.isFile() ||
    receiptInfo.isSymbolicLink() ||
    (receiptInfo.mode & 0o777) !== 0o600 ||
    (await readFile(receiptPath, 'utf8')) !== receipt
  )
    throw new Error('Node install receipt is incompatible.');
  return { ...result, nodeExecutable };
}

// Keep the published v2/v3 receipt runner directly executable for older installers.
if (
  process.argv[1] !== undefined &&
  process.env.REVO_BOOTSTRAP_ENTRY !== '1' &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  if (process.env.REVO_INSTALL_MODE === 'pnpm')
    await runInstallMode({
      dataPath: process.argv[2],
      receiptPath: process.env.REVO_RECEIPT_PATH,
      target: process.env.REVO_NODE_TARGET,
      archiveSha256: process.env.REVO_NODE_ARCHIVE_SHA256,
      channelRoot: process.env.REVO_INSTALL_ROOT,
      privateNodeRoot: process.env.REVO_PRIVATE_NODE_ROOT,
      scratch: process.env.REVO_INSTALL_SCRATCH,
    });
  else
    await runBootstrap({
      dataPath: process.argv[2],
      receiptPath: process.env.REVO_RECEIPT_PATH,
      target: process.env.REVO_NODE_TARGET,
      archiveSha256: process.env.REVO_NODE_ARCHIVE_SHA256,
    });
