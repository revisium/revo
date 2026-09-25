// oxlint-disable no-unsafe-type-assertion, no-explicit-any, vitest/require-mock-type-parameters -- compact installer scenario
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { InstallSessionScenario } from './support/installation/install-session-scenario.js';
import {
  embeddedBootstrap,
  pnpmInstallerBuilderScenario,
} from './support/installation/installer-builder-scenario.js';
import { pnpmBootstrapScenario } from './support/installation/pnpm-bootstrap-scenario.js';

type Data = Record<string, any>;
type Api = {
  provisionPnpm: (input: Data) => Promise<Data>;
  PNPM_PROGRESS_STAGES: readonly string[];
};
const api = await vi.importActual<Api>(
  new URL('../installer/node-bootstrap.mjs', import.meta.url).href,
);
const sanitizer = await vi.importActual<{
  sanitizeProbeDiagnostic: (value: string) => string;
}>(new URL('../installer/probe-diagnostic.mjs', import.meta.url).href);
const engine = new URL('../installer/node-bootstrap.mjs', import.meta.url).pathname;
const { buildInstaller } = await vi.importActual<{ buildInstaller: (input: unknown) => string }>(
  new URL('../installer/build-installer.mjs', import.meta.url).href,
);
const base = embeddedBootstrap(
  buildInstaller(
    pnpmInstallerBuilderScenario({
      core: '4.3.2',
      admin: '5.4.3',
      node: process.versions.node,
      pnpm: '12.5.1',
    }),
  ),
) as Data;

const fixture = async (
  hardlink = false,
  version = '12.5.1',
  shebang = '#!/bin/sh',
  probeOptions: {
    readonly probeStdout?: string;
    readonly probeStderr?: string;
    readonly stdoutChunks?: readonly string[];
    readonly stderrChunks?: readonly string[];
    readonly probeExitCode?: number;
  } = {},
) => {
  const scenario = await pnpmBootstrapScenario(engine, base);
  const archive = await scenario.archive({ hardlink, version, shebang, ...probeOptions });
  const value = structuredClone(base);
  const selected = value.pnpmArchives.find(
    (item: Data) => item.platform === 'linux' && item.arch === 'x64',
  );
  value.pnpmArchives = value.pnpmArchives.map((item: Data) =>
    item === selected ? { ...item, sha256: archive.sha256 } : item,
  );
  await scenario.write(value);
  await mkdir(join(scenario.root, 'channel'));
  return { scenario, value, archive, channelRoot: join(scenario.root, 'channel') };
};
const request = (bytes: Uint8Array) =>
  vi.fn(async () => ({
    status: 200,
    headers: new Headers({ 'content-length': String(bytes.length) }),
    body: (async function* () {
      yield bytes;
    })(),
  }));
const target = (root: string) =>
  join(root, 'channel', 'pnpm', process.versions.node, 'linux-x64', '12.5.1');

describe('managed pnpm bootstrap target', () => {
  it('publishes verified pnpm atomically with exact receipt and progress', async () => {
    const data = await fixture();
    const stages: string[] = [];
    const result = await api.provisionPnpm({
      bootstrap: data.value,
      nodeExecutable: data.scenario.nodeExecutable,
      channelRoot: data.channelRoot,
      scratch: data.scenario.root,
      platform: 'linux',
      arch: 'x64',
      request: request(data.archive.bytes),
      onProgress: (stage: string) => stages.push(stage),
    });
    expect(result).toEqual({
      executablePath: join(target(data.scenario.root), 'pnpm'),
      version: '12.5.1',
      reused: false,
    });
    expect(stages).toEqual(['validate', 'download', 'verify', 'extract', 'probe', 'publish']);
    expect(await readFile(join(target(data.scenario.root), 'install-receipt.json'), 'utf8')).toBe(
      `${JSON.stringify({ schemaVersion: 'revo-pnpm-bootstrap/v1', version: '12.5.1', nodeVersion: process.versions.node, platform: 'linux', arch: 'x64', archiveSha256: data.archive.sha256 })}\n`,
    );
    expect(
      (await stat(join(target(data.scenario.root), 'install-receipt.json'))).mode & 0o777,
    ).toBe(0o600);
  });
  it('probes and reuses a compatible target without downloading', async () => {
    const data = await fixture();
    const first = await api.provisionPnpm({
      bootstrap: data.value,
      nodeExecutable: data.scenario.nodeExecutable,
      channelRoot: data.channelRoot,
      scratch: data.scenario.root,
      platform: 'linux',
      arch: 'x64',
      request: request(data.archive.bytes),
    });
    const stages: string[] = [];
    const requestAgain = request(data.archive.bytes);
    const reused = await api.provisionPnpm({
      bootstrap: data.value,
      nodeExecutable: data.scenario.nodeExecutable,
      channelRoot: data.channelRoot,
      scratch: data.scenario.root,
      platform: 'linux',
      arch: 'x64',
      request: requestAgain,
      onProgress: (stage: string) => stages.push(stage),
    });
    expect(first.reused).toBe(false);
    expect(reused.reused).toBe(true);
    expect(requestAgain).not.toHaveBeenCalled();
    expect(stages).toEqual(['validate', 'probe', 'reuse']);
  });
  it('keeps fresh and reused version probes independent of the caller project and home', async () => {
    const data = await fixture();
    await writeFile(
      join(data.scenario.root, 'package.json'),
      `${JSON.stringify({ packageManager: 'pnpm@12.4.1' })}\n`,
    );
    const first = await api.provisionPnpm({
      bootstrap: data.value,
      nodeExecutable: data.scenario.nodeExecutable,
      channelRoot: data.channelRoot,
      scratch: data.scenario.root,
      platform: 'linux',
      arch: 'x64',
      request: request(data.archive.bytes),
    });
    const stages: string[] = [];
    const reused = await api.provisionPnpm({
      bootstrap: data.value,
      nodeExecutable: data.scenario.nodeExecutable,
      channelRoot: data.channelRoot,
      scratch: data.scenario.root,
      platform: 'linux',
      arch: 'x64',
      request: request(data.archive.bytes),
      onProgress: (stage: string) => stages.push(stage),
    });
    expect(first.version).toBe('12.5.1');
    expect(reused).toMatchObject({ version: '12.5.1', reused: true });
    expect(stages).toEqual(['validate', 'probe', 'reuse']);
  });
  it('reports a wrong executable version during probe before publishing its target', async () => {
    const data = await fixture(false, '12.4.1');
    const stages: string[] = [];
    await expect(
      api.provisionPnpm({
        bootstrap: data.value,
        nodeExecutable: data.scenario.nodeExecutable,
        channelRoot: data.channelRoot,
        scratch: data.scenario.root,
        platform: 'linux',
        arch: 'x64',
        request: request(data.archive.bytes),
        onProgress: (stage: string) => stages.push(stage),
      }),
    ).rejects.toMatchObject({
      message: 'pnpm probe: version mismatch',
      diagnosticCode: 'PNPM_PROBE_FAILED',
      diagnosticDetail: 'expected 12.5.1, actual 12.4.1',
    });
    expect(stages).toEqual(['validate', 'download', 'verify', 'extract', 'probe']);
    await expect(stat(target(data.scenario.root))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves the executable spawn error code in bounded probe diagnostics', async () => {
    const data = await fixture(false, '12.5.1', '#!/revo-missing-interpreter');
    await expect(
      api.provisionPnpm({
        bootstrap: data.value,
        nodeExecutable: data.scenario.nodeExecutable,
        channelRoot: data.channelRoot,
        scratch: data.scenario.root,
        platform: 'linux',
        arch: 'x64',
        request: request(data.archive.bytes),
      }),
    ).rejects.toMatchObject({
      diagnosticCode: 'PNPM_PROBE_FAILED',
      diagnosticDetail: expect.stringContaining('spawn ENOENT'),
    });
  });
  it('redacts credentials before applying the diagnostic byte limit across child chunks', async () => {
    const data = await fixture(false, '12.5.1', '#!/bin/sh', {
      stderrChunks: [
        `${'x'.repeat(950)}https://boundary-user:boundary-password`,
        '@h/?token=boundary-token',
      ],
      probeExitCode: 1,
    });
    const failure = await api
      .provisionPnpm({
        bootstrap: data.value,
        nodeExecutable: data.scenario.nodeExecutable,
        channelRoot: data.channelRoot,
        scratch: data.scenario.root,
        platform: 'linux',
        arch: 'x64',
        request: request(data.archive.bytes),
      })
      .catch((error: Data) => error);
    expect(failure).toMatchObject({ diagnosticCode: 'PNPM_PROBE_FAILED' });
    expect(failure.diagnosticDetail).not.toContain('boundary-user');
    expect(failure.diagnosticDetail).not.toContain('boundary-password');
    expect(failure.diagnosticDetail).not.toContain('boundary-token');
    expect(failure.diagnosticDetail).toContain('https://[redacted]@h/');
    expect(Buffer.byteLength(failure.diagnosticDetail, 'utf8')).toBeLessThanOrEqual(1_024);
    await expect(stat(target(data.scenario.root))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('omits a stderr stream that overflows capture instead of retaining a secret prefix', async () => {
    const data = await fixture(false, '12.5.1', '#!/bin/sh', {
      stderrChunks: [
        `${'capture-secret-prefix-'.repeat(200)}https://capture-user:capture-password`,
        '@registry.example/pkg?token=capture-token',
      ],
      probeExitCode: 1,
    });
    const failure = await api
      .provisionPnpm({
        bootstrap: data.value,
        nodeExecutable: data.scenario.nodeExecutable,
        channelRoot: data.channelRoot,
        scratch: data.scenario.root,
        platform: 'linux',
        arch: 'x64',
        request: request(data.archive.bytes),
      })
      .catch((error: Data) => error);
    expect(failure).toMatchObject({ diagnosticCode: 'PNPM_PROBE_FAILED' });
    expect(failure.diagnosticDetail).toContain('[stderr omitted: capture limit exceeded]');
    expect(failure.diagnosticDetail).not.toContain('capture-secret-prefix');
    expect(failure.diagnosticDetail).not.toContain('capture-password');
    expect(failure.diagnosticDetail).not.toContain('capture-token');
  });
  it.each([
    ...[
      ['non-breaking space', '\u00a0'],
      ['em space', '\u2003'],
      ['narrow no-break space', '\u202f'],
      ['byte-order mark', '\ufeff'],
    ].map(([label, separator]) => ({
      label: `URL authority split by ${label}`,
      chunks: [
        'https://first-secret',
        `${separator}second-secret`,
        '@host.invalid/path?key=query-secret#fragment-secret',
      ],
      expected: '[probe detail omitted: ambiguous whitespace]',
      secrets: ['first-secret', 'second-secret', 'query-secret', 'fragment-secret'],
    })),
    {
      label: 'query tail split by non-breaking space',
      chunks: ['https://host.invalid/path?key=first-secret', '\u00a0second-secret'],
      expected: '[probe detail omitted: ambiguous whitespace]',
      secrets: ['first-secret', 'second-secret'],
    },
    {
      label: 'multiple at signs',
      chunks: ['https://double-user:part', '@double-password@host/path'],
      expected: 'https://[redacted]@host/path',
      secrets: ['double-user', 'double-password'],
    },
    {
      label: 'tab inside authority',
      chunks: ['https://tab-user:tab-password', '\t@host/path'],
      expected: '[probe detail omitted: embedded control]',
      secrets: ['tab-user', 'tab-password'],
    },
    {
      label: 'newline inside authority',
      chunks: ['https://newline-user:newline-password', '\n@host/path'],
      expected: '[probe detail omitted: embedded control]',
      secrets: ['newline-user', 'newline-password'],
    },
    {
      label: 'empty host after credentials',
      chunks: ['https://empty-host-user:empty-host-password@/path'],
      expected: '[probe detail omitted: ambiguous URL authority]',
      secrets: ['empty-host-user', 'empty-host-password'],
    },
    {
      label: 'IPv6 host with port, path, query and fragment',
      chunks: ['https://ipv6-user:ipv6-password@[::1]:443/path?token=ipv6-query#ipv6-fragment'],
      expected: 'https://[redacted]@[::1]:443/path',
      secrets: ['ipv6-user', 'ipv6-password', 'ipv6-query', 'ipv6-fragment'],
    },
    {
      label: 'a double quote in userinfo',
      chunks: ['https://quote-user:double"quote-secret@host/path'],
      expected: '[probe detail omitted: ambiguous URL authority]',
      secrets: ['quote-user', 'quote-secret'],
    },
    {
      label: 'a single quote in userinfo',
      chunks: ["https://single-user:single'quote-secret@host/path"],
      expected: '[probe detail omitted: ambiguous URL authority]',
      secrets: ['single-user', 'quote-secret'],
    },
    {
      label: 'a backtick in userinfo',
      chunks: ['https://tick-user:tick`secret@host/path'],
      expected: '[probe detail omitted: ambiguous URL authority]',
      secrets: ['tick-user', 'tick`secret'],
    },
    {
      label: 'angle brackets in userinfo',
      chunks: ['https://angle-user:angle<secret>@host/path>'],
      expected: '[probe detail omitted: ambiguous URL authority]',
      secrets: ['angle-user', 'angle<secret'],
    },
    {
      label: 'quotes in query and fragment',
      chunks: ['https://host/path?key="query-secret"#fragment-secret'],
      expected: '[probe detail omitted: ambiguous URL authority]',
      secrets: ['query-secret', 'fragment-secret'],
    },
  ])('sanitizes $label from child stderr through the private session log', async (testCase) => {
    const data = await fixture(false, '12.5.1', '#!/bin/sh', {
      stderrChunks: testCase.chunks,
      probeExitCode: 1,
    });
    const failure = await api
      .provisionPnpm({
        bootstrap: data.value,
        nodeExecutable: data.scenario.nodeExecutable,
        channelRoot: data.channelRoot,
        scratch: data.scenario.root,
        platform: 'linux',
        arch: 'x64',
        request: request(data.archive.bytes),
      })
      .catch((error: Data) => error);
    expect(failure).toMatchObject({ diagnosticCode: 'PNPM_PROBE_FAILED' });
    expect(failure.diagnosticDetail).toContain(testCase.expected);
    const isOmitted = testCase.expected.startsWith('[probe detail omitted:');
    expect(failure.diagnosticDetail).toBe(isOmitted ? testCase.expected : failure.diagnosticDetail);
    expect(Buffer.byteLength(failure.diagnosticDetail, 'utf8')).toBeLessThanOrEqual(1_024);
    const sanitizedDetail = sanitizer.sanitizeProbeDiagnostic(failure.diagnosticDetail);
    expect(sanitizedDetail === testCase.expected).toBe(isOmitted);
    expect(sanitizedDetail).toBe(failure.diagnosticDetail);
    for (const secret of testCase.secrets) {
      expect(failure.diagnosticDetail).not.toContain(secret);
    }
    await expect(stat(target(data.scenario.root))).rejects.toMatchObject({ code: 'ENOENT' });

    const session = new InstallSessionScenario();
    const diagnosticRoot = await mkdtemp(join(tmpdir(), 'revo-probe-redaction-session-'));
    session.session.stage('probe');
    try {
      await session.session.fail(
        diagnosticRoot,
        Object.assign(new Error('pnpm probe failed'), {
          diagnosticCode: failure.diagnosticCode,
          diagnosticDetail: failure.diagnosticDetail,
        }),
      );
      const log = await readFile(join(diagnosticRoot, 'install-session.log'), 'utf8');
      expect(log).toContain(testCase.expected);
      expect(log).toContain('[PNPM_PROBE_FAILED]');
      for (const secret of testCase.secrets) {
        expect(log).not.toContain(secret);
        expect(session.errors.join('')).not.toContain(secret);
      }
      const terminalMarker = isOmitted ? testCase.expected : '\u0000';
      expect(session.errors.join('')).not.toContain(terminalMarker);
      expect(session.errors.join('')).toContain('[PNPM_PROBE_FAILED]');
    } finally {
      await rm(diagnosticRoot, { recursive: true, force: true });
    }
  });
  it('is idempotent at URL, redaction-marker and UTF-8 size boundaries', () => {
    const inputs = [
      'https://user:secret@[::1]:443/path?token=value#fragment',
      `${'x'.repeat(1_000)}https://user:secret@host/path`,
      `${'x'.repeat(1_000)}https://[::1]:443/path`,
      `${'x'.repeat(1_010)}é`,
    ];
    for (const input of inputs) {
      const once = sanitizer.sanitizeProbeDiagnostic(input);
      expect(sanitizer.sanitizeProbeDiagnostic(once)).toBe(once);
      expect(Buffer.byteLength(once, 'utf8')).toBeLessThanOrEqual(1_024);
    }
  });
  it('omits details containing non-ASCII whitespace but keeps ordinary spaces', () => {
    const marker = '[probe detail omitted: ambiguous whitespace]';
    for (const separator of [
      '\u00a0',
      '\u1680',
      ...Array.from({ length: 11 }, (_, index) => String.fromCodePoint(0x2000 + index)),
      '\u202f',
      '\u205f',
      '\u3000',
      '\ufeff',
    ]) {
      const sanitized = sanitizer.sanitizeProbeDiagnostic(
        `https://secret${separator}@host.invalid/path`,
      );
      expect(sanitized).toBe(marker);
      expect(sanitizer.sanitizeProbeDiagnostic(sanitized)).toBe(marker);
      expect(Buffer.byteLength(sanitized, 'utf8')).toBeLessThanOrEqual(1_024);
    }
    expect(
      sanitizer.sanitizeProbeDiagnostic(
        'failed to probe https://user:password@host.invalid/path?token=value#fragment',
      ),
    ).toBe('failed to probe https://[redacted]@host.invalid/path');
  });
  it('does not echo malformed or overlong version output into probe diagnostics', async () => {
    const malformed = await fixture(false, '12.5.1', '#!/bin/sh', {
      probeStdout: `https://stdout-user:stdout-password@registry.example/${'x'.repeat(140)}\n`,
    });
    const mismatch = await api
      .provisionPnpm({
        bootstrap: malformed.value,
        nodeExecutable: malformed.scenario.nodeExecutable,
        channelRoot: malformed.channelRoot,
        scratch: malformed.scenario.root,
        platform: 'linux',
        arch: 'x64',
        request: request(malformed.archive.bytes),
      })
      .catch((error: Data) => error);
    expect(mismatch.diagnosticDetail).toContain('<invalid version output>');
    expect(mismatch.diagnosticDetail).not.toContain('stdout-user');
    expect(mismatch.diagnosticDetail).not.toContain('stdout-password');

    const overflow = await fixture(false, '12.5.1', '#!/bin/sh', {
      probeStdout: `12.5.1\n${'stdout-overflow-secret-'.repeat(220)}`,
    });
    const oversized = await api
      .provisionPnpm({
        bootstrap: overflow.value,
        nodeExecutable: overflow.scenario.nodeExecutable,
        channelRoot: overflow.channelRoot,
        scratch: overflow.scenario.root,
        platform: 'linux',
        arch: 'x64',
        request: request(overflow.archive.bytes),
      })
      .catch((error: Data) => error);
    expect(oversized.diagnosticDetail).toContain('[stdout omitted: capture limit exceeded]');
    expect(oversized.diagnosticDetail).not.toContain('stdout-overflow-secret');
    await expect(stat(target(overflow.scenario.root))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('provisions and reuses an archive containing an internal hardlink', async () => {
    const data = await fixture(true);
    const requestFirst = request(data.archive.bytes);
    const first = await api.provisionPnpm({
      bootstrap: data.value,
      nodeExecutable: data.scenario.nodeExecutable,
      channelRoot: data.channelRoot,
      scratch: data.scenario.root,
      platform: 'linux',
      arch: 'x64',
      request: requestFirst,
    });
    expect(first.reused).toBe(false);
    expect(requestFirst).toHaveBeenCalledTimes(1);
    const [original, copy] = await Promise.all([
      stat(join(target(data.scenario.root), 'dist', 'index.js')),
      stat(join(target(data.scenario.root), 'dist', 'copy.js')),
    ]);
    expect(copy.ino).toBe(original.ino);
    expect(copy.nlink).toBe(2);

    const requestAgain = request(data.archive.bytes);
    const reused = await api.provisionPnpm({
      bootstrap: data.value,
      nodeExecutable: data.scenario.nodeExecutable,
      channelRoot: data.channelRoot,
      scratch: data.scenario.root,
      platform: 'linux',
      arch: 'x64',
      request: requestAgain,
    });
    expect(reused.reused).toBe(true);
    expect(requestAgain).not.toHaveBeenCalled();
  });
  it('fails closed before request for Windows', async () => {
    const data = await fixture();
    const req = request(data.archive.bytes);
    await expect(
      api.provisionPnpm({
        bootstrap: data.value,
        nodeExecutable: data.scenario.nodeExecutable,
        channelRoot: data.channelRoot,
        scratch: data.scenario.root,
        platform: 'win32',
        arch: 'x64',
        request: req,
      }),
    ).rejects.toThrow(/Windows|unsupported/iu);
    expect(req).not.toHaveBeenCalled();
  });
  it('rejects unsafe ancestors, incompatible receipt and target races without touching unrelated data', async () => {
    const data = await fixture();
    const unsafe = join(data.scenario.root, 'unsafe');
    await symlink('/tmp', unsafe);
    await expect(
      api.provisionPnpm({
        bootstrap: data.value,
        nodeExecutable: data.scenario.nodeExecutable,
        channelRoot: unsafe,
        scratch: data.scenario.root,
        platform: 'linux',
        arch: 'x64',
        request: request(data.archive.bytes),
      }),
    ).rejects.toThrow(/channel|target|unsafe/iu);
    expect(await readdir(data.channelRoot)).toEqual([]);
  });
  it('converges concurrent attempts on one compatible target', async () => {
    const data = await fixture();
    const outcomes = await Promise.all(
      [0, 1].map(() =>
        api.provisionPnpm({
          bootstrap: data.value,
          nodeExecutable: data.scenario.nodeExecutable,
          channelRoot: data.channelRoot,
          scratch: data.scenario.root,
          platform: 'linux',
          arch: 'x64',
          request: request(data.archive.bytes),
        }),
      ),
    );
    expect(outcomes.map(({ reused }) => reused).sort((a, b) => Number(a) - Number(b))).toEqual([
      false,
      true,
    ]);
    expect(await stat(target(data.scenario.root))).toBeTruthy();
  });
  it('exposes the finite progress contract', () =>
    expect(api.PNPM_PROGRESS_STAGES).toEqual([
      'validate',
      'download',
      'verify',
      'extract',
      'probe',
      'publish',
      'reuse',
    ]));
});
