import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
// oxlint-disable no-await-in-loop, no-unsafe-type-assertion -- synthetic process/archive probes keep all effects fixture-owned
import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { superviseInstallDiagnostic } from './support/installation/pnpm-install-diagnostic-supervisor.mjs';
import type {
  ArchiveFileSystem,
  PnpmArchiveRequest,
} from './support/installation/pnpm-install-diagnostic-support.mjs';
import {
  PNPM_DIAGNOSTIC_ABORT_MS,
  PNPM_DIAGNOSTIC_MAX_ARCHIVE_BYTES,
  PNPM_DIAGNOSTIC_MAX_EXPANDED_BYTES,
  PNPM_DIAGNOSTIC_MAX_REPORT_BYTES,
  PNPM_DIAGNOSTIC_SNAPSHOTS_MS,
  boundedDiagnosticReport,
  createBoundedProgressObserver,
  createDiagnosticSchedule,
  createObservedSpawn,
  downloadPinnedPnpmArchive,
  extractVerifiedPnpmArchive,
  isSafeDriverMessage,
  matchesPnpmInvocation,
  observeSpawnedChild,
  readBoundedArchiveDescriptor,
  readInstallLogSnapshot,
} from './support/installation/pnpm-install-diagnostic-support.mjs';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const execFile = promisify(execFileCallback);
const fixtureDriverPath = fileURLToPath(
  new URL('./support/installation/pnpm-install-diagnostic-fixture-child.mjs', import.meta.url),
);

function runFixture(
  scenario: string,
  limits: {
    readonly snapshotAtMs?: readonly number[];
    readonly abortAtMs?: number;
    readonly teardownMs?: number;
    readonly forceWaitMs?: number;
    readonly driverCloseTimeoutMs?: number;
    readonly maxLedgerBytes?: number;
  } = {},
) {
  return superviseInstallDiagnostic({
    driverPath: fixtureDriverPath,
    input: {
      moduleUrl: 'file:///fixture/module.mjs',
      nodeExecutable: process.execPath,
      pnpmExecutable: '/fixture/pnpm',
      stage: { directory: '/fixture/stage', packageDirectory: '/fixture/stage', version: '1.0.0' },
    },
    environment: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      REVO_DIAGNOSTIC_FIXTURE_SCENARIO: scenario,
    },
    limits: {
      readyTimeoutMs: 500,
      spawnTimeoutMs: 500,
      snapshotAtMs: [],
      abortAtMs: 1_000,
      teardownMs: 30,
      forceWaitMs: 30,
      driverCloseTimeoutMs: 500,
      ...limits,
    },
  });
}

function tarHeader(
  name: string,
  size: number,
  type: '0' | '1' | '5' | '2' = '0',
  linkname?: string,
  mode = name === 'pnpm' ? 0o755 : 0o644,
): Buffer {
  const value = Buffer.alloc(512);
  value.write(name, 0, 100, 'utf8');
  value.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
  value.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  value[156] = type.charCodeAt(0);
  if (linkname !== undefined) {
    value.write(linkname, 157, 100, 'utf8');
  }
  value.write('ustar\0', 257, 6, 'ascii');
  value.fill(32, 148, 156);
  const checksum = [...value].reduce((sum, byte) => sum + byte, 0);
  value.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return value;
}

function pnpmTar(
  entries: readonly {
    name: string;
    content?: string;
    type?: '0' | '1' | '5' | '2';
    linkname?: string;
    mode?: number;
    declaredSize?: number;
  }[],
): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '');
    const type = entry.type ?? '0';
    const size = entry.declaredSize ?? (type === '1' ? 0 : content.length);
    parts.push(tarHeader(entry.name, size, type, entry.linkname, entry.mode));
    if (type === '0') {
      parts.push(content);
      if (content.length % 512) {
        parts.push(Buffer.alloc(512 - (content.length % 512)));
      }
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const tarEntries = () => [
  { name: 'pnpm', content: '#!/usr/bin/env node\n' },
  { name: 'dist/', type: '5' as const },
  { name: 'dist/index.js', content: 'export {}\n' },
];

function fakeFileStat(size: number, mtimeMs = 1) {
  return {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    size,
    dev: 7,
    ino: 9,
    mtimeMs,
  } as unknown as import('node:fs').Stats;
}

function fakeArchiveFileSystem(options: {
  readonly pathSize: number;
  readonly descriptorStats: readonly ReturnType<typeof fakeFileStat>[];
  readonly bytes?: Buffer;
  readonly forcedReadBytes?: number;
}) {
  type OpenedArchiveFile = Awaited<ReturnType<ArchiveFileSystem['open']>>;
  let statIndex = 0;
  const close = vi.fn<OpenedArchiveFile['close']>(async () => undefined);
  const read = vi.fn<OpenedArchiveFile['read']>(async (target, offset, length, position) => {
    const bytesRead = Math.min(
      length,
      options.forcedReadBytes ?? length,
      (options.bytes?.length ?? 0) - position,
    );
    if (bytesRead > 0) {
      options.bytes?.copy(target, offset, position, position + bytesRead);
    }
    return { bytesRead, buffer: target };
  });
  const stat = vi.fn<OpenedArchiveFile['stat']>(async () => {
    const descriptorStat =
      options.descriptorStats[Math.min(statIndex++, options.descriptorStats.length - 1)];
    if (!descriptorStat) {
      throw new Error('fixture omitted a descriptor stat');
    }
    return descriptorStat;
  });
  return {
    fileSystem: {
      lstat: vi.fn<ArchiveFileSystem['lstat']>(async () => fakeFileStat(options.pathSize)),
      open: vi.fn<ArchiveFileSystem['open']>(async () => ({ stat, read, close })),
    },
    read,
    close,
  };
}

describe('manual pnpm install diagnostic guardrails', () => {
  it('matches only the exact executable, argv and stage cwd', () => {
    const expected = {
      executable: '/private/pnpm',
      args: ['install', '--prod'],
      cwd: '/stage/package',
    };
    expect(
      matchesPnpmInvocation(
        { command: '/private/pnpm', args: [...expected.args], options: { cwd: expected.cwd } },
        expected,
      ),
    ).toBe(true);
    expect(
      matchesPnpmInvocation(
        { command: '/other/pnpm', args: expected.args, options: { cwd: expected.cwd } },
        expected,
      ),
    ).toBe(false);
    expect(
      matchesPnpmInvocation(
        { command: '/private/pnpm', args: ['install'], options: { cwd: expected.cwd } },
        expected,
      ),
    ).toBe(false);
    expect(
      matchesPnpmInvocation(
        { command: '/private/pnpm', args: expected.args, options: { cwd: '/other' } },
        expected,
      ),
    ).toBe(false);
  });

  it('calls original spawn once with the same this, arguments, options and child identity', () => {
    const receiver = { marker: 'same receiver' };
    const argv = ['install', '--prod'];
    const options = {
      cwd: '/stage/package',
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    const child = new EventEmitter();
    let received: unknown[] = [];
    let observed = 0;
    const expected = { executable: '/private/pnpm', args: argv, cwd: options.cwd };
    const observer = createObservedSpawn({
      original: function (...args) {
        received = [this, ...args];
        return child;
      },
      expected,
      observeChild() {
        observed += 1;
      },
    });
    const actual = Reflect.apply(observer.spawn, receiver, ['/private/pnpm', argv, options]);
    expect(actual).toBe(child);
    expect(received).toEqual([receiver, '/private/pnpm', argv, options]);
    expect(received[2]).toBe(argv);
    expect(received[3]).toBe(options);
    expect(observer.summary()).toEqual({ calls: 1, matches: 1, observerIncomplete: false });
    expect(observed).toBe(1);
  });

  it('preserves spawn exception identity and reports observer exceptions without changing spawn result', () => {
    const spawnFailure = Object.assign(new Error('secret message'), { code: 'EACCES' });
    const failedObserver = createObservedSpawn({
      original: () => {
        throw spawnFailure;
      },
      expected: { executable: '/private/pnpm', args: [], cwd: '/stage' },
      observeChild() {},
    });
    expect(() => failedObserver.spawn('/private/pnpm', [], { cwd: '/stage' })).toThrow(
      spawnFailure,
    );

    const child = new EventEmitter();
    const observer = createObservedSpawn({
      original: () => child,
      expected: { executable: '/private/pnpm', args: [], cwd: '/stage' },
      observeChild() {
        throw new Error('observer secret');
      },
    });
    expect(observer.spawn('/private/pnpm', [], { cwd: '/stage' })).toBe(child);
    expect(observer.summary()).toMatchObject({ calls: 1, matches: 1, observerIncomplete: true });
  });

  it('records heartbeat as allowlisted activity and keeps silent output distinguishable', () => {
    const heartbeat = createBoundedProgressObserver(() => 25);
    const secretLine = `${JSON.stringify({ name: 'pnpm:progress', status: 'fetched', packageId: 'secret-package-name' })}\n`;
    heartbeat.feed(secretLine);
    heartbeat.finish();
    const active = heartbeat.snapshot();
    expect(active.stdoutBytes).toBe(Buffer.byteLength(secretLine));
    expect(active.activity).toEqual([{ name: 'pnpm:progress:fetched', count: 1 }]);
    expect(JSON.stringify(active)).not.toContain('secret-package-name');

    const silent = createBoundedProgressObserver(() => 26).snapshot();
    expect(silent.stdoutBytes).toBe(0);
    expect(silent.stderrBytes).toBe(0);
    expect(silent.activity).toEqual([]);
  });

  it('observes spawn error and exit-without-close as distinct nonterminal process evidence', () => {
    const events: Record<string, unknown>[] = [];
    const stream = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    child.stderr = stream;
    const observed = observeSpawnedChild(child, {
      onEvent: (event) => events.push(event),
      now: () => 10,
    });
    child.emit('error', Object.assign(new Error('not reported'), { code: 'ENOENT' }));
    child.emit('exit', null, 'SIGTERM');
    expect(observed.snapshot()).toMatchObject({
      errorSeen: true,
      exitSeen: true,
      closeSeen: false,
    });
    expect(events.map((event) => event.name)).toEqual(['spawn-error', 'exit']);
    expect(events[0]?.errorCode).toBe('ENOENT');
  });

  it('schedules snapshots from confirmed spawn, aborts once and requires bounded teardown', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const schedule = createDiagnosticSchedule({
        sendSnapshot: (id) => calls.push(`snapshot:${id}`),
        sendAbort: () => calls.push('abort'),
        onFallback: (reason) => calls.push(`fallback:${reason}`),
        snapshotAtMs: [5, 10],
        abortAtMs: 15,
        teardownMs: 10,
      });
      schedule.start();
      await vi.advanceTimersByTimeAsync(25);
      expect(calls).toEqual(['snapshot:0', 'snapshot:1', 'abort', 'fallback:teardown-deadline']);
      schedule.finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels scheduled work on bounded completion and never reports a false fallback', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const schedule = createDiagnosticSchedule({
        sendSnapshot: (id) => calls.push(`snapshot:${id}`),
        sendAbort: () => calls.push('abort'),
        onFallback: (reason) => calls.push(`fallback:${reason}`),
        snapshotAtMs: [5, 10],
        abortAtMs: 15,
        teardownMs: 10,
      });
      schedule.start();
      await vi.advanceTimersByTimeAsync(5);
      schedule.finish();
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toEqual(['snapshot:0']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the specified real observation schedule and bounded report size', () => {
    expect(PNPM_DIAGNOSTIC_SNAPSHOTS_MS).toEqual([
      30_000, 60_000, 120_000, 180_000, 300_000, 540_000,
    ]);
    expect(PNPM_DIAGNOSTIC_ABORT_MS).toBe(600_000);
    expect(PNPM_DIAGNOSTIC_MAX_ARCHIVE_BYTES).toBe(64 * 1024 * 1024);
    expect(PNPM_DIAGNOSTIC_MAX_EXPANDED_BYTES).toBe(128 * 1024 * 1024);
    expect(PNPM_DIAGNOSTIC_MAX_REPORT_BYTES).toBe(16 * 1024);
    expect(() =>
      boundedDiagnosticReport({ detail: 'x'.repeat(PNPM_DIAGNOSTIC_MAX_REPORT_BYTES) }),
    ).toThrow(/bound/u);
  });

  it('reads only a bounded regular-file tail and refuses missing or symlink logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-pnpm-log-test-'));
    try {
      const path = join(root, 'install.log');
      expect(await readInstallLogSnapshot(path, undefined, root)).toMatchObject({
        safe: false,
        reason: 'missing',
      });
      await writeFile(path, `${'a'.repeat(8_192)}secret-tail`);
      const first = await readInstallLogSnapshot(path, undefined, root);
      expect(first).toMatchObject({ safe: true, size: 8_203, tailChanged: true });
      expect(first).not.toHaveProperty('tail');
      expect(first).not.toHaveProperty('content');
      if (!first.safe) {
        throw new Error('expected a safe install log snapshot');
      }
      const second = await readInstallLogSnapshot(path, first.tailDigest, root);
      expect(second).toMatchObject({ safe: true, size: first.size, tailChanged: false });
      await rm(path);
      await symlink('/etc/passwd', path);
      expect(await readInstallLogSnapshot(path, undefined, root)).toMatchObject({ safe: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('downloads only bounded HTTPS release content and verifies its pinned digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-pnpm-download-test-'));
    const bytes = Buffer.from('pinned archive bytes');
    const digestValue = digest(bytes);
    const calls: string[] = [];
    const request = vi.fn<PnpmArchiveRequest>(async (url) => {
      calls.push(url);
      if (calls.length === 1) {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://release-assets.githubusercontent.com/file?sig=secret',
          }),
          body: null,
        };
      }
      return {
        status: 200,
        headers: new Headers({ 'content-length': String(bytes.length) }),
        body: (async function* () {
          yield bytes;
        })(),
      };
    });
    const destination = join(root, 'pnpm.tar.gz');
    try {
      const result = await downloadPinnedPnpmArchive({
        descriptor: {
          url: 'https://github.com/pnpm/pnpm/releases/download/v12.4.1/pnpm-linux-x64.tar.gz',
          sha256: digestValue,
        },
        destination,
        request,
      });
      expect(result).toEqual({ size: bytes.length, redirects: 1, sha256: digestValue });
      expect(calls).toHaveLength(2);
      expect(await readFile(destination)).toEqual(bytes);
      expect(JSON.stringify(result)).not.toContain('secret');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects truncated, oversized, mismatched and untrusted archive responses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-pnpm-download-fail-'));
    const destination = join(root, 'pnpm.tar.gz');
    const bytes = Buffer.from('small');
    const descriptor = {
      url: 'https://github.com/pnpm/pnpm/releases/download/v12.4.1/pnpm-linux-x64.tar.gz',
      sha256: digest(bytes),
    };
    const response = (body: Uint8Array, length = body.length) => ({
      status: 200,
      headers: new Headers({ 'content-length': String(length) }),
      body: (async function* () {
        yield body;
      })(),
    });
    try {
      await expect(
        downloadPinnedPnpmArchive({
          descriptor,
          destination,
          maxBytes: 4,
          request: async () => response(bytes),
        }),
      ).rejects.toThrow(/bound/u);
      await writeFile(destination, 'user-owned');
      await expect(
        downloadPinnedPnpmArchive({
          descriptor,
          destination,
          request: async () => response(bytes),
        }),
      ).rejects.toHaveProperty('code', 'EEXIST');
      expect(await readFile(destination, 'utf8')).toBe('user-owned');
      await rm(destination);
      await expect(
        downloadPinnedPnpmArchive({
          descriptor,
          destination,
          request: async () => response(bytes.subarray(0, 2), bytes.length),
        }),
      ).rejects.toThrow(/truncated/u);
      await expect(
        downloadPinnedPnpmArchive({
          descriptor: { ...descriptor, sha256: '0'.repeat(64) },
          destination,
          request: async () => response(bytes),
        }),
      ).rejects.toThrow(/checksum/u);
      await expect(
        downloadPinnedPnpmArchive({
          descriptor: {
            ...descriptor,
            url: 'http://github.com/pnpm/pnpm/releases/download/v12.4.1/a',
          },
          destination,
          request: async () => response(bytes),
        }),
      ).rejects.toThrow(/descriptor/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('extracts only regular files under the pnpm layout and removes failed stages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-pnpm-extract-test-'));
    const archivePath = join(root, 'archive.tgz');
    await mkdir(join(root, 'toolchain'));
    try {
      const validArchive = pnpmTar(tarEntries());
      await writeFile(archivePath, validArchive);
      const extracted = await extractVerifiedPnpmArchive({
        archivePath,
        destinationRoot: join(root, 'toolchain'),
        expectedSha256: digest(validArchive),
      });
      expect(await readFile(extracted.executablePath, 'utf8')).toContain('node');
      expect((await lstat(extracted.executablePath)).mode & 0o111).toBeTruthy();
      expect(await readdir(join(extracted.directory, 'dist'))).toEqual(['index.js']);
      await rm(extracted.directory, { recursive: true, force: true });

      for (const { entries, expectedError } of [
        {
          entries: [{ name: '../escape', content: 'outside' }],
          expectedError: /contains an unsafe path/u,
        },
        {
          entries: [{ name: 'pnpm', content: 'x', type: '2' as const }, ...tarEntries().slice(1)],
          expectedError: /contains a link or special file/u,
        },
        {
          entries: [
            { name: 'pnpm', content: '', declaredSize: PNPM_DIAGNOSTIC_MAX_EXPANDED_BYTES + 1 },
          ],
          expectedError: /expanded data exceeds bound/u,
        },
      ]) {
        const unsafeArchive = pnpmTar(entries);
        await writeFile(archivePath, unsafeArchive);
        await expect(
          extractVerifiedPnpmArchive({
            archivePath,
            destinationRoot: join(root, 'toolchain'),
            expectedSha256: digest(unsafeArchive),
          }),
        ).rejects.toThrow(expectedError);
        expect(await readdir(join(root, 'toolchain'))).toEqual([]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('materializes only prior in-dist hardlinks as independent regular files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-pnpm-hardlink-test-'));
    const archivePath = join(root, 'archive.tgz');
    const destinationRoot = join(root, 'toolchain');
    const sentinel = join(root, 'outside-sentinel');
    await mkdir(destinationRoot);
    await writeFile(sentinel, 'unchanged sentinel');
    try {
      const entries = [
        ...tarEntries(),
        { name: 'dist/copy.js', type: '1' as const, linkname: 'dist/index.js' },
      ];
      const archive = pnpmTar(entries);
      await writeFile(archivePath, archive);
      const extracted = await extractVerifiedPnpmArchive({
        archivePath,
        destinationRoot,
        expectedSha256: digest(archive),
      });
      const original = join(extracted.directory, 'dist/index.js');
      const copy = join(extracted.directory, 'dist/copy.js');
      const [originalInfo, copyInfo] = await Promise.all([lstat(original), lstat(copy)]);
      expect(originalInfo.isFile() && !originalInfo.isSymbolicLink()).toBe(true);
      expect(copyInfo.isFile() && !copyInfo.isSymbolicLink()).toBe(true);
      expect(originalInfo.ino).not.toBe(copyInfo.ino);
      expect(originalInfo.nlink).toBe(1);
      expect(copyInfo.nlink).toBe(1);
      expect(await readFile(copy, 'utf8')).toBe('export {}\n');
      await writeFile(copy, 'modified copy');
      expect(await readFile(original, 'utf8')).toBe('export {}\n');
      expect(await readFile(sentinel, 'utf8')).toBe('unchanged sentinel');
      await rm(extracted.directory, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unsafe hardlink targets and cleans every failed stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-pnpm-hardlink-negative-'));
    const archivePath = join(root, 'archive.tgz');
    const destinationRoot = join(root, 'toolchain');
    const sentinel = join(root, 'outside-sentinel');
    await mkdir(destinationRoot);
    await writeFile(sentinel, 'unchanged sentinel');
    try {
      const validPrefix = [...tarEntries(), { name: 'dist/subdir/', type: '5' as const }];
      const validDirectoryArchive = pnpmTar(validPrefix);
      await writeFile(archivePath, validDirectoryArchive);
      const extractedDirectory = await extractVerifiedPnpmArchive({
        archivePath,
        destinationRoot,
        expectedSha256: digest(validDirectoryArchive),
      });
      const directoryTarget = join(extractedDirectory.directory, 'dist', 'subdir');
      const directoryInfo = await lstat(directoryTarget);
      expect(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink()).toBe(true);
      await rm(extractedDirectory.directory, { recursive: true, force: true });
      expect(await readdir(destinationRoot)).toEqual([]);

      const cases = [
        {
          entry: { name: 'dist/absolute.js', type: '1' as const, linkname: '/outside' },
          expectedError: /unsafe path/u,
        },
        {
          entry: { name: 'dist/traversal.js', type: '1' as const, linkname: 'dist/../pnpm' },
          expectedError: /unsafe path/u,
        },
        {
          entry: { name: 'dist/outside.js', type: '1' as const, linkname: 'pnpm' },
          expectedError: /hardlink target/u,
        },
        {
          entry: {
            name: 'dist/missing.js',
            type: '1' as const,
            linkname: 'dist/missing-target.js',
          },
          expectedError: /hardlink target/u,
        },
        {
          entry: { name: 'dist/directory-copy.js', type: '1' as const, linkname: 'dist/subdir' },
          expectedError: /hardlink target/u,
        },
        {
          entry: { name: 'dist/self.js', type: '1' as const, linkname: 'dist/self.js' },
          expectedError: /hardlink target/u,
        },
        {
          entry: {
            name: 'dist/nonempty.js',
            type: '1' as const,
            linkname: 'dist/index.js',
            declaredSize: 1,
          },
          expectedError: /hardlink size/u,
        },
        {
          entry: { name: 'dist/index.js', type: '1' as const, linkname: 'dist/index.js' },
          expectedError: /duplicate/u,
        },
        {
          entry: {
            name: 'dist/mode.js',
            type: '1' as const,
            linkname: 'dist/index.js',
            mode: 0o600,
          },
          expectedError: /hardlink mode/u,
        },
      ];

      for (const { entry, expectedError } of cases) {
        const archive = pnpmTar([...validPrefix, entry]);
        await writeFile(archivePath, archive);
        await expect(
          extractVerifiedPnpmArchive({
            archivePath,
            destinationRoot,
            expectedSha256: digest(archive),
          }),
        ).rejects.toThrow(expectedError);
        expect(await readdir(destinationRoot)).toEqual([]);
        expect(await readFile(sentinel, 'utf8')).toBe('unchanged sentinel');
      }

      const forwardReference = pnpmTar([
        ...validPrefix,
        { name: 'dist/forward.js', type: '1' as const, linkname: 'dist/later.js' },
        { name: 'dist/later.js', content: 'later target' },
      ]);
      await writeFile(archivePath, forwardReference);
      await expect(
        extractVerifiedPnpmArchive({
          archivePath,
          destinationRoot,
          expectedSha256: digest(forwardReference),
        }),
      ).rejects.toThrow(/hardlink target/u);
      expect(await readdir(destinationRoot)).toEqual([]);
      expect(await readFile(sentinel, 'utf8')).toBe('unchanged sentinel');

      const hardlinkChain = pnpmTar([
        ...validPrefix,
        { name: 'dist/first-copy.js', type: '1' as const, linkname: 'dist/index.js' },
        { name: 'dist/second-copy.js', type: '1' as const, linkname: 'dist/first-copy.js' },
      ]);
      await writeFile(archivePath, hardlinkChain);
      await expect(
        extractVerifiedPnpmArchive({
          archivePath,
          destinationRoot,
          expectedSha256: digest(hardlinkChain),
        }),
      ).rejects.toThrow(/hardlink target/u);
      expect(await readdir(destinationRoot)).toEqual([]);
      expect(await readFile(sentinel, 'utf8')).toBe('unchanged sentinel');

      const expandedLimit =
        Buffer.byteLength('#!/usr/bin/env node\n') + Buffer.byteLength('export {}\n');
      const expandedArchive = pnpmTar([
        ...validPrefix,
        { name: 'dist/materialized-copy.js', type: '1' as const, linkname: 'dist/index.js' },
      ]);
      await writeFile(archivePath, expandedArchive);
      await expect(
        extractVerifiedPnpmArchive({
          archivePath,
          destinationRoot,
          expectedSha256: digest(expandedArchive),
          maxExpandedBytes: expandedLimit,
        }),
      ).rejects.toThrow(/expanded data exceeds bound/u);
      expect(await readdir(destinationRoot)).toEqual([]);
      expect(await readFile(sentinel, 'utf8')).toBe('unchanged sentinel');

      await expect(
        extractVerifiedPnpmArchive({
          archivePath,
          destinationRoot,
          expectedSha256: digest(expandedArchive),
          maxExpandedBytes: PNPM_DIAGNOSTIC_MAX_EXPANDED_BYTES + 1,
        }),
      ).rejects.toThrow(/expansion bound is invalid/u);
      expect(await readdir(destinationRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects archive descriptor growth before allocating and closes every opened descriptor', async () => {
    const bytes = Buffer.from('small');
    const oversized = fakeArchiveFileSystem({
      pathSize: bytes.length,
      descriptorStats: [fakeFileStat(PNPM_DIAGNOSTIC_MAX_ARCHIVE_BYTES + 1)],
      bytes,
    });
    const allocate = vi.fn<(size: number) => Buffer>((size) => Buffer.alloc(size));
    await expect(
      readBoundedArchiveDescriptor({
        archivePath: '/fixture/archive.tgz',
        expectedSha256: digest(bytes),
        fileSystem: oversized.fileSystem,
        allocate,
      }),
    ).rejects.toThrow(/changed during verification/u);
    expect(allocate).not.toHaveBeenCalled();
    expect(oversized.read).not.toHaveBeenCalled();
    expect(oversized.close).toHaveBeenCalledOnce();

    const short = fakeArchiveFileSystem({
      pathSize: bytes.length,
      descriptorStats: [fakeFileStat(bytes.length), fakeFileStat(bytes.length)],
      bytes: bytes.subarray(0, 2),
    });
    await expect(
      readBoundedArchiveDescriptor({
        archivePath: '/fixture/archive.tgz',
        expectedSha256: digest(bytes),
        fileSystem: short.fileSystem,
      }),
    ).rejects.toThrow(/truncated/u);
    expect(short.close).toHaveBeenCalledOnce();

    const changed = fakeArchiveFileSystem({
      pathSize: bytes.length,
      descriptorStats: [fakeFileStat(bytes.length, 1), fakeFileStat(bytes.length, 2)],
      bytes,
    });
    await expect(
      readBoundedArchiveDescriptor({
        archivePath: '/fixture/archive.tgz',
        expectedSha256: digest(bytes),
        fileSystem: changed.fileSystem,
      }),
    ).rejects.toThrow(/changed during verification/u);
    expect(changed.close).toHaveBeenCalledOnce();
  });

  it('accepts only strict bounded child messages and omits untrusted fields', () => {
    const safe = { type: 'event', name: 'close', atMs: 20, code: 0, signal: null };
    expect(isSafeDriverMessage(safe)).toBe(true);
    expect(isSafeDriverMessage({ ...safe, raw: 'secret output' })).toBe(false);
    expect(
      isSafeDriverMessage({ type: 'event', name: 'failure', atMs: 0, message: 'secret' }),
    ).toBe(false);
    expect(
      isSafeDriverMessage({
        type: 'snapshot',
        id: -1,
        atMs: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
        logSafe: true,
        logState: 'safe',
      }),
    ).toBe(false);
    expect(isSafeDriverMessage({ ...safe, signal: 'secret-signal' })).toBe(false);
    expect(
      isSafeDriverMessage({
        type: 'snapshot',
        id: 6,
        atMs: 20,
        stdoutBytes: 100,
        stderrBytes: 0,
        logSafe: true,
        logState: 'safe',
        logSize: 512,
        tailChanged: true,
        activity: [],
        lastActivityMs: null,
        errorCodes: [],
        malformedLines: 0,
        droppedLines: 0,
        raw: 'secret',
      }),
    ).toBe(false);
    expect(
      isSafeDriverMessage({
        type: 'result',
        outcome: 'success',
        atMs: 20,
        stdoutBytes: 100,
        stderrBytes: 0,
        observerIncomplete: false,
        exitCode: 0,
        signal: null,
        message: 'secret',
      }),
    ).toBe(false);
    const safeSnapshot = {
      type: 'snapshot',
      id: 0,
      atMs: 20,
      stdoutBytes: 0,
      stderrBytes: 0,
      logSafe: true,
      logState: 'safe',
      logSize: 0,
      tailChanged: false,
      activity: [],
      lastActivityMs: null,
      errorCodes: [],
      malformedLines: 0,
      droppedLines: 0,
    } as const;
    expect(
      isSafeDriverMessage({ ...safeSnapshot, activity: [{ name: 'secret-package', count: 1 }] }),
    ).toBe(false);
    expect(
      isSafeDriverMessage({
        ...safeSnapshot,
        activity: [
          { name: 'pnpm:progress:fetched', count: 1 },
          { name: 'pnpm:progress:fetched', count: 2 },
        ],
      }),
    ).toBe(false);
    expect(isSafeDriverMessage({ ...safeSnapshot, logSafe: false, logState: 'safe' })).toBe(false);
    expect(
      isSafeDriverMessage({
        ...safeSnapshot,
        activity: [{ name: 'pnpm:progress:fetched', count: 10_001 }],
      }),
    ).toBe(false);
    expect(
      isSafeDriverMessage({
        ...safeSnapshot,
        errorCodes: [
          { code: 'EIO', count: 1 },
          { code: 'EIO', count: 2 },
        ],
      }),
    ).toBe(false);
    expect(record(safe)).toBe(true);
  });

  it('supervises real fixture children through successful, heartbeat and early-error terminal paths', async () => {
    const success = await runFixture('success');
    expect(success).toMatchObject({
      state: 'terminal',
      outcome: 'success',
      pnpmSpawnSeen: true,
      pnpmCloseSeen: true,
      driverExitSeen: true,
      driverCloseSeen: true,
      driverStatusConsistent: true,
      cleanupConfirmed: true,
      sandboxStoppedConfirmed: false,
    });

    const heartbeat = await runFixture('heartbeat');
    expect(heartbeat.outcome).toBe('success');
    const heartbeatSnapshot = heartbeat.snapshots?.[0];
    if (!heartbeatSnapshot?.logSafe) {
      throw new Error('expected a safe heartbeat snapshot');
    }
    expect(heartbeatSnapshot.activity).toEqual([{ name: 'pnpm:progress:fetched', count: 2 }]);

    const earlyError = await runFixture('early-driver-error');
    expect(earlyError).toMatchObject({
      state: 'terminal',
      outcome: 'driver-error',
      driverStatusConsistent: true,
      cleanupConfirmed: false,
      sandboxStoppedConfirmed: false,
    });
  });

  it('acknowledges abort and distinguishes a settled install from a silent hang', async () => {
    const settled = await runFixture('abort-settle', {
      abortAtMs: 15,
      teardownMs: 40,
      forceWaitMs: 30,
    });
    expect(settled).toMatchObject({
      outcome: 'install-error',
      abortRequested: true,
      abortSent: true,
      abortReceived: true,
      pnpmStatusConsistent: true,
      cleanupConfirmed: true,
    });

    for (const scenario of ['silent-hang', 'ignore-abort']) {
      const incomplete = await runFixture(scenario, {
        abortAtMs: 15,
        teardownMs: 25,
        forceWaitMs: 25,
      });
      expect(incomplete).toMatchObject({
        state: 'terminal',
        outcome: 'observer-incomplete',
        abortRequested: true,
        abortReceived: false,
        cleanupConfirmed: false,
        sandboxStoppedConfirmed: false,
        fallback: 'teardown-deadline',
      });
    }
  });

  it('rejects disconnected, duplicate and contradictory driver protocol traces', async () => {
    const disconnected = await runFixture('disconnect');
    expect(disconnected).toMatchObject({ outcome: 'observer-incomplete', cleanupConfirmed: false });
    expect(disconnected.fallback).toBe('driver-disconnected-before-result');

    const duplicate = await runFixture('duplicate-result');
    expect(duplicate).toMatchObject({ outcome: 'observer-incomplete', cleanupConfirmed: false });
    expect(duplicate.fallback).toBe('post-result-message');

    const contradictory = await runFixture('contradictory');
    expect(contradictory).toMatchObject({
      outcome: 'observer-incomplete',
      cleanupConfirmed: false,
    });
    expect(contradictory.fallback).toBe('terminal-contract-invalid');
  });

  it('waits for driver close after exit when a fixture-owned descendant holds stderr open', async () => {
    const report = await runFixture('inherited-pipe', { driverCloseTimeoutMs: 1_000 });
    expect(report).toMatchObject({
      outcome: 'driver-error',
      driverExitSeen: true,
      driverCloseSeen: true,
      driverStatusConsistent: true,
      cleanupConfirmed: false,
    });
    expect(report.durationMs).toBeGreaterThanOrEqual(80);
  });

  it('emits a bounded terminal incomplete report when child messages exceed the ledger', async () => {
    const report = await runFixture('budget-overflow', { maxLedgerBytes: 4_000 });
    expect(report).toMatchObject({
      state: 'terminal',
      outcome: 'observer-incomplete',
      cleanupConfirmed: false,
      sandboxStoppedConfirmed: false,
      fallback: 'driver-report-budget-exceeded',
    });
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(
      PNPM_DIAGNOSTIC_MAX_REPORT_BYTES,
    );
  });

  it('proves runtime discovery excludes manual and opt-out manual config has no effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-manual-discovery-test-'));
    const marker = join(root, 'sentinel.jsonl');
    const vitestCli = join(process.cwd(), 'node_modules/vitest/vitest.mjs');
    const path = process.env.PATH ?? '/usr/bin:/bin';
    try {
      const discovery = await execFile(
        process.execPath,
        [
          vitestCli,
          'list',
          '--run',
          '--filesOnly',
          '--staticParse',
          '--config',
          'vitest.config.ts',
        ],
        {
          cwd: process.cwd(),
          env: { PATH: path, HOME: root, CI: '1', NO_COLOR: '1' },
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      expect(discovery.stdout).toContain('test/pnpm-install-diagnostic.test.ts');
      expect(discovery.stdout).not.toContain('test/manual/pnpm-install-timing.manual.ts');

      const home = join(root, 'home');
      await mkdir(home, { recursive: true, mode: 0o700 });
      const manualRun = await execFile(
        process.execPath,
        [
          vitestCli,
          'run',
          '--config',
          'vitest.manual.config.ts',
          'test/manual/pnpm-install-timing.manual.ts',
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: path,
            HOME: home,
            CI: '1',
            NO_COLOR: '1',
            REVO_RUN_PNPM_INSTALL_DIAGNOSTIC: '0',
            REVO_MANUAL_DIAGNOSTIC_GUARD: '1',
            REVO_MANUAL_DIAGNOSTIC_GUARD_MARKER: marker,
          },
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      expect(manualRun.stdout).toContain('pnpm-install-timing.manual.ts');
      const markers = (await readFile(marker, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
      expect(markers.length).toBeGreaterThan(0);
      expect(markers.some((value) => record(value) && value.phase === 'complete')).toBe(true);
      for (const value of markers) {
        expect(value).toMatchObject({
          armed: true,
          fetchCalls: 0,
          networkCalls: 0,
          taskSpawns: 0,
          fixtureCreates: 0,
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
