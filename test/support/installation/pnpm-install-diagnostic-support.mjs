import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const PNPM_DIAGNOSTIC_SNAPSHOTS_MS = Object.freeze([
  30_000, 60_000, 120_000, 180_000, 300_000, 540_000,
]);
export const PNPM_DIAGNOSTIC_ABORT_MS = 600_000;
export const PNPM_DIAGNOSTIC_MAX_REPORT_BYTES = 16 * 1024;
export const PNPM_DIAGNOSTIC_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const PNPM_DIAGNOSTIC_MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_TAR_ENTRIES = 10_000;
const MAX_PROGRESS_LINE_BYTES = 4_096;
const SAFE_ERROR_CODES = new Set([
  'EACCES',
  'EEXIST',
  'EINTR',
  'EINVAL',
  'EIO',
  'EMFILE',
  'ENOENT',
  'ENOSPC',
  'EPERM',
  'EPIPE',
  'ESRCH',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'UND_ERR_ABORTED',
]);
const PROGRESS_NAMES = new Set([
  'pnpm:stage',
  'pnpm:progress',
  'pnpm:root',
  'pnpm:execution-time',
  'pnpm',
]);
const PROGRESS_STATUSES = new Set([
  'started',
  'progress',
  'completed',
  'failed',
  'resolved',
  'fetched',
  'found_in_store',
  'imported',
  'activity',
]);
const PROGRESS_ACTIVITY_NAMES = new Set([
  ...[...PROGRESS_NAMES].flatMap((name) =>
    name === 'pnpm:stage'
      ? ['stage-started', 'stage-completed', 'other'].map((status) => `${name}:${status}`)
      : [...PROGRESS_STATUSES, 'other'].map((status) => `${name}:${status}`),
  ),
]);

const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const safeCounter = (value) => Number.isSafeInteger(value) && value >= 0;
const exactKeys = (value, keys) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const SIGNALS = new Set([
  'SIGABRT',
  'SIGALRM',
  'SIGBUS',
  'SIGCHLD',
  'SIGCONT',
  'SIGFPE',
  'SIGHUP',
  'SIGILL',
  'SIGINT',
  'SIGKILL',
  'SIGPIPE',
  'SIGQUIT',
  'SIGSEGV',
  'SIGSTOP',
  'SIGTERM',
  'SIGTRAP',
  'SIGTSTP',
  'SIGTTIN',
  'SIGTTOU',
  'SIGUSR1',
  'SIGUSR2',
]);
const LOG_STATES = new Set([
  'safe',
  'missing',
  'unavailable',
  'not-regular',
  'read-failed',
  'nofollow-unavailable',
  'changed',
  'unsafe-path',
  'unsafe-root',
]);
const sameArray = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);
const safeCode = (value) => (SAFE_ERROR_CODES.has(value) ? value : 'other');

export function matchesPnpmInvocation(call, expected) {
  return (
    record(call) &&
    record(expected) &&
    call.command === expected.executable &&
    call.options?.cwd === expected.cwd &&
    sameArray(call.args, expected.args)
  );
}

export function createObservedSpawn({ original, expected, observeChild = () => undefined }) {
  let calls = 0;
  let matches = 0;
  let observerIncomplete = false;
  const spawn = function (...args) {
    calls += 1;
    const [command, argv, options] = args;
    const matched = matchesPnpmInvocation({ command, args: argv, options }, expected);
    if (matched) {
      matches += 1;
    }
    let child;
    try {
      child = Reflect.apply(original, this, args);
    } catch (cause) {
      if (matched) {
        try {
          observeChild(undefined, { type: 'spawn-error', code: safeCode(cause?.code) });
        } catch {
          observerIncomplete = true;
        }
      }
      throw cause;
    }
    if (matched) {
      try {
        observeChild(child, { type: 'spawn' });
      } catch {
        observerIncomplete = true;
      }
    }
    return child;
  };
  return {
    spawn,
    original,
    summary: () => ({ calls, matches, observerIncomplete }),
  };
}

export function observeSpawnedChild(
  child,
  { onEvent = () => undefined, onStderr: consumeStderr = () => undefined, now = () => 0 } = {},
) {
  const state = { errorSeen: false, exitSeen: false, closeSeen: false, spawnSeen: false };
  const emit = (name, fields = {}) => {
    try {
      onEvent({ name, atMs: Math.max(0, Math.round(now())), ...fields });
    } catch {
      state.observerIncomplete = true;
    }
  };
  if (!child) {
    state.errorSeen = true;
    emit('spawn-error');
  } else {
    const onSpawn = () => {
      state.spawnSeen = true;
      emit('spawn');
    };
    const onStderrData = (chunk) => {
      try {
        consumeStderr(chunk);
      } catch {
        state.observerIncomplete = true;
      }
    };
    const onError = (cause) => {
      state.errorSeen = true;
      emit('spawn-error', { errorCode: safeCode(cause?.code) });
    };
    const onExit = (code, signal) => {
      state.exitSeen = true;
      emit('exit', { code, signal });
    };
    const onClose = (code, signal) => {
      state.closeSeen = true;
      emit('close', { code, signal });
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      child.stderr?.removeListener('data', onStderrData);
    };
    child.once('spawn', onSpawn);
    child.stderr?.on('data', onStderrData);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('close', onClose);
  }
  return { snapshot: () => ({ ...state }) };
}

export function createBoundedProgressObserver(now = () => Date.now()) {
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let buffer = '';
  let malformed = 0;
  let dropped = 0;
  let discardingLine = false;
  let lastActivityMs = null;
  const errorCodes = new Map();
  const counts = new Map();
  const add = (key) => {
    const previous = counts.get(key) ?? 0;
    if (previous < 10_000) {
      counts.set(key, previous + 1);
    } else {
      dropped += 1;
    }
  };
  const consumeLine = (line) => {
    if (Buffer.byteLength(line) > MAX_PROGRESS_LINE_BYTES) {
      dropped += 1;
      return;
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      malformed += 1;
      return;
    }
    if (!record(value) || !PROGRESS_NAMES.has(value.name)) {
      dropped += 1;
      return;
    }
    let status;
    if (value.name === 'pnpm:stage') {
      status =
        typeof value.stage === 'string' && /^[a-z0-9-]{1,48}_(?:started|done)$/u.test(value.stage)
          ? value.stage.endsWith('_started')
            ? 'stage-started'
            : 'stage-completed'
          : 'other';
    } else {
      status =
        typeof value.status === 'string' && PROGRESS_STATUSES.has(value.status)
          ? value.status
          : 'other';
    }
    add(`${value.name}:${status}`);
    if (value.name !== 'pnpm' || status !== 'other') {
      lastActivityMs = Math.max(0, Math.round(now()));
    }
    const errorCode = safeCode(value.err?.code);
    if (errorCode !== undefined && value.err?.code !== undefined) {
      const count = errorCodes.get(errorCode) ?? 0;
      if (count < 100) {
        errorCodes.set(errorCode, count + 1);
      }
    }
  };
  const feed = (chunk) => {
    try {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      stdoutBytes = Math.min(Number.MAX_SAFE_INTEGER, stdoutBytes + bytes.length);
      let remaining = bytes.toString('utf8');
      if (discardingLine) {
        const newlineAt = remaining.indexOf('\n');
        if (newlineAt < 0) {
          return;
        }
        remaining = remaining.slice(newlineAt + 1);
        discardingLine = false;
      }
      buffer += remaining;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          break;
        }
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        if (Buffer.byteLength(line) > MAX_PROGRESS_LINE_BYTES) {
          dropped += 1;
        } else {
          consumeLine(line);
        }
        buffer = buffer.slice(newline + 1);
      }
      if (Buffer.byteLength(buffer) > MAX_PROGRESS_LINE_BYTES) {
        buffer = '';
        discardingLine = true;
        dropped += 1;
      }
    } catch {
      dropped += 1;
    }
  };
  const addStderr = (chunk) => {
    try {
      const length = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + length);
    } catch {
      dropped += 1;
    }
  };
  const finish = () => {
    try {
      if (buffer && !discardingLine) {
        consumeLine(buffer);
      }
    } catch {
      dropped += 1;
    }
    buffer = '';
  };
  const snapshot = () => ({
    stdoutBytes,
    stderrBytes,
    malformedLines: malformed,
    droppedLines: dropped,
    activity: [...counts.entries()].slice(0, 32).map(([name, count]) => ({ name, count })),
    lastActivityMs,
    errorCodes: [...errorCodes.entries()].map(([code, count]) => ({ code, count })),
  });
  return { feed, addStderr, finish, snapshot };
}

export async function readInstallLogSnapshot(path, previousTail, fixtureRoot) {
  if (typeof fixtureRoot !== 'string' || !fixtureRoot.startsWith('/') || !path.startsWith('/')) {
    return { safe: false, reason: 'unsafe-path' };
  }
  const rootPath = resolve(fixtureRoot);
  const logPath = resolve(path);
  if (dirname(logPath) !== rootPath || relative(rootPath, logPath).startsWith('..')) {
    return { safe: false, reason: 'unsafe-path' };
  }
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') {
    return { safe: false, reason: 'nofollow-unavailable' };
  }
  const [rootInfo, rootReal, pathInfo, pathReal] = await Promise.all([
    lstat(rootPath).catch(() => undefined),
    realpath(rootPath).catch(() => undefined),
    lstat(logPath).catch(() => undefined),
    realpath(logPath).catch(() => undefined),
  ]);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || rootReal !== rootPath) {
    return { safe: false, reason: 'unsafe-root' };
  }
  if (!pathInfo?.isFile() || pathInfo.isSymbolicLink() || pathReal !== logPath) {
    return { safe: false, reason: pathInfo === undefined ? 'missing' : 'not-regular' };
  }
  let file;
  try {
    file = await open(logPath, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
  } catch (cause) {
    return { safe: false, reason: cause?.code === 'ENOENT' ? 'missing' : 'unavailable' };
  }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.dev !== pathInfo.dev || before.ino !== pathInfo.ino) {
      return { safe: false, reason: 'changed' };
    }
    const size = Math.max(0, before.size);
    const length = Math.min(4_096, size);
    const tail = Buffer.alloc(length);
    if (length) {
      const read = await file.read(tail, 0, length, size - length);
      if (read.bytesRead !== length) {
        return { safe: false, reason: 'changed' };
      }
    }
    const after = await file.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      return { safe: false, reason: 'changed' };
    }
    const digest = createHash('sha256').update(tail).digest('hex');
    return {
      safe: true,
      size,
      tailChanged: previousTail === undefined ? length > 0 : digest !== previousTail,
      tailDigest: digest,
    };
  } catch {
    return { safe: false, reason: 'read-failed' };
  } finally {
    await file.close().catch(() => undefined);
  }
}

export async function downloadPinnedPnpmArchive({
  descriptor,
  destination,
  signal,
  timeoutMs = 120_000,
  maxBytes = PNPM_DIAGNOSTIC_MAX_ARCHIVE_BYTES,
  request = globalThis.fetch,
}) {
  if (
    !record(descriptor) ||
    !/^https:\/\/github\.com\/pnpm\/pnpm\/releases\/download\/v/u.test(descriptor.url) ||
    !/^[a-f0-9]{64}$/u.test(descriptor.sha256) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > PNPM_DIAGNOSTIC_MAX_ARCHIVE_BYTES
  ) {
    throw new Error('pnpm archive descriptor or bounds are invalid');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let file;
  let created = false;
  let success = false;
  let current = new URL(descriptor.url);
  let redirects = 0;
  try {
    if (signal?.aborted) {
      throw new Error('pnpm archive download cancelled');
    }
    for (;;) {
      if (
        current.protocol !== 'https:' ||
        current.username ||
        current.password ||
        current.hash ||
        ![
          'github.com',
          'release-assets.githubusercontent.com',
          'objects.githubusercontent.com',
        ].includes(current.hostname)
      ) {
        throw new Error('pnpm archive redirect is unsafe');
      }
      // oxlint-disable-next-line no-await-in-loop -- each response determines whether another redirect is needed.
      const response = await request(current.href, {
        redirect: 'manual',
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get?.('location');
        // oxlint-disable-next-line no-await-in-loop -- release this response before following its redirect.
        await response.body?.cancel?.().catch?.(() => undefined);
        if (!location || redirects >= 2) {
          throw new Error('pnpm archive redirects exceeded');
        }
        current = new URL(location, current);
        redirects += 1;
        continue;
      }
      if (response.status !== 200) {
        // oxlint-disable-next-line no-await-in-loop -- release the rejected response before returning an error.
        await response.body?.cancel?.().catch?.(() => undefined);
        throw new Error('pnpm archive download returned an unexpected status');
      }
      const rawLength = response.headers?.get?.('content-length');
      const declaredLength = rawLength ? Number(rawLength) : undefined;
      if (
        declaredLength !== undefined &&
        (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes)
      ) {
        throw new Error('pnpm archive exceeds its download bound');
      }
      // oxlint-disable-next-line no-await-in-loop -- create the destination only after the final redirect is validated.
      file = await open(destination, 'wx', 0o600);
      created = true;
      const digest = createHash('sha256');
      let size = 0;
      if (!response.body || !(Symbol.asyncIterator in response.body)) {
        throw new Error('pnpm archive response body is unavailable');
      }
      // oxlint-disable-next-line no-await-in-loop -- consume and persist chunks serially to preserve stream backpressure and order.
      for await (const chunk of response.body) {
        if (controller.signal.aborted) {
          throw new Error('pnpm archive download timed out');
        }
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes) {
          throw new Error('pnpm archive exceeds its download bound');
        }
        digest.update(bytes);
        await file.writeFile(bytes);
      }
      if (declaredLength !== undefined && size !== declaredLength) {
        throw new Error('pnpm archive response was truncated');
      }
      if (digest.digest('hex') !== descriptor.sha256) {
        throw new Error('pnpm archive checksum mismatch');
      }
      success = true;
      return { size, redirects, sha256: descriptor.sha256 };
    }
  } catch (cause) {
    if (signal?.aborted) {
      throw new Error('pnpm archive download cancelled', { cause });
    }
    if (controller.signal.aborted) {
      throw new Error('pnpm archive download timed out', { cause });
    }
    throw cause;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await file?.close().catch(() => undefined);
    if (!success && created) {
      await rm(destination, { force: true }).catch(() => undefined);
    }
  }
}

export function boundedDiagnosticReport(value) {
  if (!record(value)) {
    throw new Error('diagnostic report is invalid');
  }
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > PNPM_DIAGNOSTIC_MAX_REPORT_BYTES) {
    throw new Error('diagnostic report exceeds bound');
  }
  return value;
}

export function createDiagnosticSchedule({
  sendSnapshot,
  sendAbort,
  onFallback,
  snapshotAtMs = PNPM_DIAGNOSTIC_SNAPSHOTS_MS,
  abortAtMs = PNPM_DIAGNOSTIC_ABORT_MS,
  teardownMs = 10_000,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  const timers = [];
  let started = false;
  let finished = false;
  const start = () => {
    if (started) {
      return;
    }
    started = true;
    snapshotAtMs.forEach((delay, id) => {
      timers.push(
        schedule(() => {
          if (!finished) {
            try {
              sendSnapshot(id);
            } catch {
              onFallback('snapshot-send-failed');
            }
          }
        }, delay),
      );
    });
    timers.push(
      schedule(() => {
        if (finished) {
          return;
        }
        try {
          sendAbort();
        } catch {
          onFallback('abort-send-failed');
        }
        timers.push(
          schedule(() => {
            if (!finished) {
              onFallback('teardown-deadline');
            }
          }, teardownMs),
        );
      }, abortAtMs),
    );
  };
  const finish = () => {
    finished = true;
    for (const timer of timers) {
      cancel(timer);
    }
  };
  return { start, finish };
}

const textField = (header, start, end) => {
  const field = header.subarray(start, end);
  const nul = field.indexOf(0);
  const bytes = nul < 0 ? field : field.subarray(0, nul);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};
const octalField = (header, start, end) => {
  const text = header
    .subarray(start, end)
    .toString('ascii')
    .replace(/[\0 ]+$/u, '')
    .trim();
  if (!/^[0-7]+$/u.test(text)) {
    throw new Error('pnpm archive has an invalid tar number');
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw new Error('pnpm archive tar number is unbounded');
  }
  return value;
};
const zeroBlock = (block) => block.every((byte) => byte === 0);
const tarName = (header) => {
  const name = textField(header, 0, 100);
  const prefix = textField(header, 345, 500);
  return prefix ? `${prefix}/${name}` : name;
};
const checkedTarPath = (name, directory) => {
  const normalized = directory ? name.replace(/\/+$/u, '') : name;
  if (!normalized || normalized.includes('\\') || normalized.startsWith('/')) {
    throw new Error('pnpm archive contains an unsafe path');
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('pnpm archive contains an unsafe path');
  }
  if (!(normalized === 'pnpm' || normalized === 'dist' || normalized.startsWith('dist/'))) {
    throw new Error('pnpm archive contains an unexpected path');
  }
  return { normalized, parts };
};

async function writeCheckedArchive(
  archiveBytes,
  output,
  maxExpandedBytes = PNPM_DIAGNOSTIC_MAX_EXPANDED_BYTES,
) {
  let tar;
  try {
    tar = gunzipSync(archiveBytes, { maxOutputLength: PNPM_DIAGNOSTIC_MAX_EXPANDED_BYTES });
  } catch {
    throw new Error('pnpm archive compression or expansion bound is invalid');
  }
  let offset = 0;
  let entries = 0;
  let expanded = 0;
  let zeroBlocks = 0;
  const kinds = new Map();
  const regularFiles = new Map();
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (zeroBlock(header)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks === 2) {
        break;
      }
      continue;
    }
    if (zeroBlocks !== 0) {
      throw new Error('pnpm archive has a malformed end marker');
    }
    entries += 1;
    if (entries > MAX_TAR_ENTRIES) {
      throw new Error('pnpm archive has too many entries');
    }
    const expectedChecksum = octalField(header, 148, 156);
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) {
      checksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    if (checksum !== expectedChecksum) {
      throw new Error('pnpm archive tar checksum is invalid');
    }
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (type !== '0' && type !== '1' && type !== '5') {
      throw new Error('pnpm archive contains a link or special file');
    }
    const mode = octalField(header, 100, 108);
    const size = octalField(header, 124, 136);
    if (type === '5' && size !== 0) {
      throw new Error('pnpm archive directory has data');
    }
    if (type === '1' && size !== 0) {
      throw new Error('pnpm archive hardlink size is invalid');
    }
    const name = tarName(header);
    const { normalized, parts } = checkedTarPath(name, type === '5');
    const previous = kinds.get(normalized);
    const kind = type === '5' ? 'directory' : 'file';
    if (previous !== undefined && previous !== kind) {
      throw new Error('pnpm archive has conflicting entries');
    }
    if (previous === 'file' || previous === 'directory') {
      throw new Error('pnpm archive has duplicate entries');
    }
    let hardlink;
    if (type === '1') {
      if (!normalized.startsWith('dist/')) {
        throw new Error('pnpm archive hardlink path is outside dist');
      }
      const linkname = textField(header, 157, 257);
      const { normalized: target } = checkedTarPath(linkname, false);
      hardlink = regularFiles.get(target);
      if (!target.startsWith('dist/') || hardlink === undefined) {
        throw new Error('pnpm archive hardlink target is not a prior regular file in dist');
      }
      if (mode !== hardlink.mode) {
        throw new Error('pnpm archive hardlink mode does not match its target');
      }
    }
    const materializedSize = hardlink === undefined ? size : hardlink.bytes.length;
    expanded += materializedSize;
    if (expanded > maxExpandedBytes) {
      throw new Error('pnpm archive expanded data exceeds bound');
    }
    offset += 512;
    const end = offset + size;
    const paddedEnd = offset + Math.ceil(size / 512) * 512;
    if (end > tar.length || paddedEnd > tar.length) {
      throw new Error('pnpm archive entry is truncated');
    }
    const target = join(output, ...parts);
    const fromRoot = relative(output, resolve(target));
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || fromRoot === '') {
      throw new Error('pnpm archive path escapes its stage');
    }
    if (type === '5') {
      // oxlint-disable-next-line no-await-in-loop -- archive entries are materialized in validated tar order.
      await mkdir(target, { recursive: true, mode: 0o700 });
    } else {
      // oxlint-disable-next-line no-await-in-loop -- create each parent before opening its archive entry.
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
      // oxlint-disable-next-line no-await-in-loop -- exclusive creation preserves duplicate-entry rejection in tar order.
      const file = await open(target, 'wx', (mode & 0o100) !== 0 ? 0o700 : 0o600);
      try {
        const contents = hardlink === undefined ? tar.subarray(offset, end) : hardlink.bytes;
        // oxlint-disable-next-line no-await-in-loop -- write one verified entry before advancing the archive cursor.
        await file.writeFile(contents);
      } finally {
        // oxlint-disable-next-line no-await-in-loop -- close the entry before processing the next tar record.
        await file.close();
      }
      if (type === '0') {
        regularFiles.set(normalized, { bytes: tar.subarray(offset, end), mode });
      }
    }
    kinds.set(normalized, kind);
    offset = paddedEnd;
  }
  if (zeroBlocks !== 2 || !tar.subarray(offset).every((byte) => byte === 0)) {
    throw new Error('pnpm archive has no valid end marker');
  }
  const executable = join(output, 'pnpm');
  const dist = join(output, 'dist');
  const [pnpmInfo, distInfo] = await Promise.all([
    stat(executable).catch(() => undefined),
    stat(dist).catch(() => undefined),
  ]);
  if (!pnpmInfo?.isFile() || (pnpmInfo.mode & 0o100) === 0 || !distInfo?.isDirectory()) {
    throw new Error('pnpm archive has no expected executable layout');
  }
  return executable;
}

export async function extractVerifiedPnpmArchive({
  archivePath,
  destinationRoot,
  expectedSha256,
  maxExpandedBytes = PNPM_DIAGNOSTIC_MAX_EXPANDED_BYTES,
}) {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error('pnpm archive checksum is invalid');
  }
  if (
    !Number.isSafeInteger(maxExpandedBytes) ||
    maxExpandedBytes < 1 ||
    maxExpandedBytes > PNPM_DIAGNOSTIC_MAX_EXPANDED_BYTES
  ) {
    throw new Error('pnpm archive expansion bound is invalid');
  }
  const destinationInfo = await lstat(destinationRoot);
  const destinationReal = await realpath(destinationRoot);
  if (
    !destinationInfo.isDirectory() ||
    destinationInfo.isSymbolicLink() ||
    destinationReal !== resolve(destinationRoot)
  ) {
    throw new Error('pnpm archive file exceeds bound');
  }
  const bytes = await readBoundedArchiveDescriptor({ archivePath, expectedSha256 });
  const destination = await import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(join(destinationRoot, 'pnpm-toolchain-')),
  );
  try {
    const executablePath = await writeCheckedArchive(bytes, destination, maxExpandedBytes);
    return { directory: destination, executablePath };
  } catch (cause) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

export async function readBoundedArchiveDescriptor({
  archivePath,
  expectedSha256,
  fileSystem = { lstat, open },
  allocate = (size) => Buffer.alloc(size),
}) {
  if (
    typeof archivePath !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(expectedSha256) ||
    typeof fileSystem?.lstat !== 'function' ||
    typeof fileSystem?.open !== 'function' ||
    typeof allocate !== 'function'
  ) {
    throw new Error('pnpm archive descriptor input is invalid');
  }
  const pathInfo = await fileSystem.lstat(archivePath);
  if (
    !pathInfo.isFile() ||
    pathInfo.isSymbolicLink() ||
    !Number.isSafeInteger(pathInfo.size) ||
    pathInfo.size < 0 ||
    pathInfo.size > PNPM_DIAGNOSTIC_MAX_ARCHIVE_BYTES
  ) {
    throw new Error('pnpm archive file exceeds bound');
  }
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') {
    throw new Error('pnpm archive no-follow is unavailable');
  }
  const archive = await fileSystem.open(
    archivePath,
    constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await archive.stat();
    if (
      !before.isFile() ||
      before.dev !== pathInfo.dev ||
      before.ino !== pathInfo.ino ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      before.size > PNPM_DIAGNOSTIC_MAX_ARCHIVE_BYTES ||
      before.size !== pathInfo.size ||
      before.mtimeMs !== pathInfo.mtimeMs
    ) {
      throw new Error('pnpm archive changed during verification');
    }
    const bytes = allocate(before.size);
    if (!Buffer.isBuffer(bytes) || bytes.length !== before.size) {
      throw new Error('pnpm archive allocation is invalid');
    }
    let offset = 0;
    while (offset < bytes.length) {
      // oxlint-disable-next-line no-await-in-loop -- descriptor reads use the previous read length to choose the next offset.
      const result = await archive.read(bytes, offset, bytes.length - offset, offset);
      if (
        !Number.isSafeInteger(result.bytesRead) ||
        result.bytesRead < 1 ||
        result.bytesRead > bytes.length - offset
      ) {
        throw new Error('pnpm archive read was truncated');
      }
      offset += result.bytesRead;
    }
    const after = await archive.stat();
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error('pnpm archive changed during verification');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
      throw new Error('pnpm archive checksum mismatch');
    }
    return bytes;
  } finally {
    await archive.close().catch(() => undefined);
  }
}

export function isSafeDriverMessage(value) {
  if (!record(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'event') {
    const common = ['type', 'name', 'atMs'];
    if (!safeCounter(value.atMs)) {
      return false;
    }
    if (['ready', 'spawn', 'abort-received', 'observer-error'].includes(value.name)) {
      return exactKeys(value, common);
    }
    if (value.name === 'spawn-error') {
      return (
        exactKeys(value, [...common, 'errorCode']) &&
        (SAFE_ERROR_CODES.has(value.errorCode) || value.errorCode === 'other')
      );
    }
    if (value.name === 'exit' || value.name === 'close') {
      return (
        exactKeys(value, [...common, 'code', 'signal']) &&
        (value.code === null ||
          (Number.isSafeInteger(value.code) && value.code >= 0 && value.code <= 255)) &&
        (value.signal === null || SIGNALS.has(value.signal))
      );
    }
    return false;
  }
  if (value.type === 'snapshot') {
    const base = ['type', 'id', 'atMs', 'stdoutBytes', 'stderrBytes', 'logSafe', 'logState'];
    const safe = value.logSafe === true;
    return (
      (safe
        ? exactKeys(value, [
            ...base,
            'logSize',
            'tailChanged',
            'activity',
            'lastActivityMs',
            'errorCodes',
            'malformedLines',
            'droppedLines',
          ])
        : exactKeys(value, base)) &&
      Number.isInteger(value.id) &&
      value.id >= 0 &&
      value.id <= 6 &&
      safeCounter(value.atMs) &&
      safeCounter(value.stdoutBytes) &&
      safeCounter(value.stderrBytes) &&
      typeof value.logSafe === 'boolean' &&
      LOG_STATES.has(value.logState) &&
      value.logSafe === (value.logState === 'safe') &&
      (safe
        ? safeCounter(value.logSize) &&
          typeof value.tailChanged === 'boolean' &&
          Array.isArray(value.activity) &&
          value.activity.length <= 32 &&
          value.activity.every(
            (item) =>
              record(item) &&
              exactKeys(item, ['name', 'count']) &&
              PROGRESS_ACTIVITY_NAMES.has(item.name) &&
              Number.isSafeInteger(item.count) &&
              item.count >= 1 &&
              item.count <= 10_000,
          ) &&
          new Set(value.activity.map((item) => item.name)).size === value.activity.length &&
          (value.lastActivityMs === null ||
            (safeCounter(value.lastActivityMs) && value.lastActivityMs <= value.atMs)) &&
          Array.isArray(value.errorCodes) &&
          value.errorCodes.length <= 16 &&
          value.errorCodes.every(
            (item) =>
              record(item) &&
              exactKeys(item, ['code', 'count']) &&
              (SAFE_ERROR_CODES.has(item.code) || item.code === 'other') &&
              Number.isSafeInteger(item.count) &&
              item.count >= 1 &&
              item.count <= 100,
          ) &&
          new Set(value.errorCodes.map((item) => item.code)).size === value.errorCodes.length &&
          safeCounter(value.malformedLines) &&
          safeCounter(value.droppedLines)
        : !safe && LOG_STATES.has(value.logState))
    );
  }
  if (value.type === 'result') {
    const optional = ['exitCode', 'signal', 'errorCode'];
    const allowed = ['success', 'install-error', 'observer-incomplete', 'driver-error'];
    if (
      !allowed.includes(value.outcome) ||
      !safeCounter(value.atMs) ||
      !safeCounter(value.stdoutBytes) ||
      !safeCounter(value.stderrBytes) ||
      typeof value.observerIncomplete !== 'boolean' ||
      Object.keys(value).some(
        (key) =>
          ![
            'type',
            'outcome',
            'atMs',
            'stdoutBytes',
            'stderrBytes',
            'observerIncomplete',
            ...optional,
          ].includes(key),
      )
    ) {
      return false;
    }
    for (const key of optional) {
      if (Object.hasOwn(value, key) && value[key] === undefined) {
        return false;
      }
    }
    if (
      Object.hasOwn(value, 'exitCode') &&
      !(
        value.exitCode === null ||
        (Number.isSafeInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255)
      )
    ) {
      return false;
    }
    if (Object.hasOwn(value, 'signal') && !(value.signal === null || SIGNALS.has(value.signal))) {
      return false;
    }
    if (
      Object.hasOwn(value, 'errorCode') &&
      !(SAFE_ERROR_CODES.has(value.errorCode) || value.errorCode === 'other')
    ) {
      return false;
    }
    if (value.outcome === 'success') {
      return (
        exactKeys(value, [
          'type',
          'outcome',
          'atMs',
          'stdoutBytes',
          'stderrBytes',
          'observerIncomplete',
          'exitCode',
          'signal',
        ]) &&
        value.observerIncomplete === false &&
        value.exitCode === 0 &&
        value.signal === null
      );
    }
    if (value.outcome === 'observer-incomplete' || value.outcome === 'driver-error') {
      return value.observerIncomplete === true;
    }
    return value.observerIncomplete === false;
  }
  return false;
}
