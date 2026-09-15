import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  InstallerPosixBootstrapScenario,
  type PosixTarget,
} from './support/installation/installer-posix-bootstrap-scenario.js';

const linuxTarget: PosixTarget = {
  system: 'Linux',
  machine: 'x86_64',
  platform: 'linux',
  arch: 'x64',
  format: 'tar.xz',
};
const targets: readonly PosixTarget[] = [
  linuxTarget,
  { system: 'Linux', machine: 'aarch64', platform: 'linux', arch: 'arm64', format: 'tar.xz' },
  { system: 'Darwin', machine: 'x86_64', platform: 'darwin', arch: 'x64', format: 'tar.gz' },
  { system: 'Darwin', machine: 'arm64', platform: 'darwin', arch: 'arm64', format: 'tar.gz' },
];

describe('generated POSIX Node publication', () => {
  const scenarios: InstallerPosixBootstrapScenario[] = [];
  const scenario = async () => {
    const value = await InstallerPosixBootstrapScenario.create();
    scenarios.push(value);
    return value;
  };

  afterEach(async () => {
    await Promise.all(scenarios.splice(0).map(async (value) => value.cleanup()));
  });

  it.each(targets)('publishes the verified $platform/$arch $format archive', async (target) => {
    const subject = await scenario();
    const result = await subject.run(target);

    expect(result.exitCode).toBe(0);
    expect(result.downloadArgv).toEqual(
      subject.expectedDownloadArgv('curl', dirname(result.payloadPath)),
    );
    expect(result.events).toEqual([
      'download',
      'sha256',
      `tar:${target.format}`,
      'probe-stdin-eof',
      'probe',
      'payload-stdin-eof',
      'payload',
    ]);
    expect(result.probeArgv.slice(1)).toEqual(['--version']);
    expect(result.probeArgv[0]).toBe(join(dirname(result.payloadPath), 'bin', 'node'));
    expect(result.payloadArgv.slice(1)).toEqual([result.payloadPath, result.dataPath]);
    expect(result.events).toContain('probe-stdin-eof');
    expect(result.events).toContain('payload-stdin-eof');
    expect(result.probeArgv[0]).not.toContain('/tools/node');
    expect(result.receipt).toEqual(subject.expectedReceipt(target));
    expect(result.receiptMode).toBe(0o600);
    expect(result.finalLayout).toEqual(['LAYOUT', 'bin', 'install-receipt.json']);
    expect(result.ownedResidue).toEqual([]);
  });

  it('falls back to wget while preserving exact URL and output arguments', async () => {
    const subject = await scenario();
    const result = await subject.run({ ...linuxTarget, downloader: 'wget' });
    expect(result.exitCode).toBe(0);
    expect(result.downloadArgv).toEqual(
      subject.expectedDownloadArgv('wget', dirname(result.payloadPath)),
    );
  });

  it('does not execute a hostile shell sentinel embedded in the real payload', async () => {
    const subject = await scenario();
    const result = await subject.run({ ...linuxTarget, payload: 'hostile' });

    expect(result.exitCode).toBe(0);
    expect(result.hostileSentinel).toBe(false);
    expect(result.receipt).toEqual(subject.expectedReceipt(linuxTarget));
  });

  it.each([
    ['unsupported operating system', { system: 'FreeBSD', machine: 'x86_64' }],
    ['unsupported architecture', { system: 'Linux', machine: 'riscv64' }],
  ])('rejects %s before download or state mutation', async (_name, rawTarget) => {
    const subject = await scenario();
    const result = await subject.run({ ...linuxTarget, ...rawTarget });
    expect(result.exitCode).not.toBe(0);
    expect(result.downloadArgv).toEqual([]);
    expect(result.targetSnapshot).toEqual([]);
    expect(result.ownedResidue).toEqual([]);
  });

  it('keeps private files and the final target hidden until the payload succeeds', async () => {
    const subject = await scenario();
    const running = await subject.start({ ...linuxTarget, payload: 'held' });
    await subject.waitFor('payload-held');

    const stage = await subject.stageSnapshot();
    const roots = stage.filter((entry) => !entry.path.slice('26.8.2/'.length).includes('/'));
    expect(roots).toEqual([
      expect.objectContaining({
        path: expect.stringMatching(/^26\.8\.2\/linux-x64\.stage\.[^/]+$/u),
        kind: 'directory',
        mode: 0o700,
      }),
    ]);
    expect(stage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringMatching(/bootstrap\.json$/u),
          kind: 'file',
          mode: 0o600,
        }),
        expect.objectContaining({
          path: expect.stringMatching(/payload\.mjs$/u),
          kind: 'file',
          mode: 0o600,
        }),
      ]),
    );
    expect(stage.some((entry) => entry.path.endsWith('/install-receipt.json'))).toBe(false);
    expect(await subject.receipt()).toBeUndefined();
    expect(await subject.finalSnapshot()).toEqual([]);

    await subject.releasePayload();
    const result = await running.finish;
    expect(result.exitCode).toBe(0);
    expect(result.receipt).toEqual(subject.expectedReceipt(linuxTarget));
    expect(result.ownedResidue).toEqual([]);
  });

  it('preserves its owned stage and archive when directly terminated', async () => {
    const subject = await scenario();
    const running = await subject.start({ ...linuxTarget, payload: 'held' });
    await subject.waitFor('payload-held');
    const heldChildPid = await subject.heldChildPid();
    const before = await subject.stageSnapshot();

    running.signal();
    const result = await running.finish;

    expect({ exitCode: result.exitCode, signalCode: result.signalCode }).toEqual({
      exitCode: null,
      signalCode: 'SIGTERM',
    });
    expect(await subject.stageSnapshot()).toEqual(before);
    expect(before.some((entry) => entry.path.endsWith('/node-archive'))).toBe(true);
    expect(result.receipt).toBeUndefined();
    expect(await subject.finalSnapshot()).toEqual([]);

    await subject.releasePayload();
    expect(await subject.waitForProcessExit(heldChildPid)).toBe(true);
    const afterChildExit = await subject.stageSnapshot();
    expect(afterChildExit.some((entry) => entry.path.endsWith('/node-archive'))).toBe(true);
    expect(afterChildExit.some((entry) => entry.path.endsWith('/install-receipt.json'))).toBe(true);
  });

  it('removes its owned stage when verification fails after a bounded step returns', async () => {
    const subject = await scenario();
    const result = await subject.run({ ...linuxTarget, publishedSha256: 'divergent' });

    expect({ exitCode: result.exitCode, signalCode: result.signalCode }).toEqual({
      exitCode: 1,
      signalCode: null,
    });
    expect(result.events).toEqual(['download', 'sha256']);
    expect(result.ownedResidue).toEqual([]);
    expect(result.finalLayout).toEqual([]);
    expect(result.receipt).toBeUndefined();
  });

  it('reuses an exact receipt only after a fresh successful Node probe', async () => {
    const subject = await scenario();
    await subject.seedValidTarget(linuxTarget);
    const before = await subject.finalSnapshot();
    const result = await subject.run(linuxTarget);
    expect(result.exitCode).toBe(0);
    expect(result.events).toEqual(['probe-stdin-eof', 'probe']);
    expect(result.probeArgv).toEqual([subject.finalNode(linuxTarget), '--version']);
    expect(result.downloadArgv).toEqual([]);
    expect(await subject.finalSnapshot()).toEqual(before);
  });

  it.each(['invalid-receipt', 'symlink'] as const)(
    'rejects an existing %s without changing it or its referent',
    async (existing) => {
      const subject = await scenario();
      await subject.seedExisting(existing, linuxTarget);
      const before = await subject.existingSnapshot();
      const result = await subject.run(linuxTarget);
      expect(result.exitCode).not.toBe(0);
      expect(await subject.existingSnapshot()).toEqual(before);
      expect(result.downloadArgv).toEqual([]);
    },
  );
});
