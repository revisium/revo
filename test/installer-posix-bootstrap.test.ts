import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InstallerPosixBootstrapScenario,
  type ExistingInstallLock,
  type InjectedFailure,
  type PosixTarget,
} from './support/installation/installer-posix-bootstrap-scenario.js';

const linuxTarget: PosixTarget = {
  system: 'Linux',
  machine: 'x86_64',
  platform: 'linux',
  arch: 'x64',
  format: 'tar.xz',
};
const lateFailures: readonly { readonly failure: InjectedFailure; readonly events: string[] }[] = [
  { failure: 'download-after-copy', events: ['download'] },
  { failure: 'sha256-after-output', events: ['download', 'sha256'] },
  { failure: 'shasum-after-output', events: ['download', 'shasum'] },
  { failure: 'tar-after-extract', events: ['download', 'sha256', 'tar:tar.xz'] },
  {
    failure: 'payload-after-receipt',
    events: [
      'download',
      'sha256',
      'tar:tar.xz',
      'probe-stdin-eof',
      'probe',
      'payload-stdin-eof',
      'payload',
    ],
  },
];
const targets: readonly PosixTarget[] = [
  linuxTarget,
  { system: 'Linux', machine: 'aarch64', platform: 'linux', arch: 'arm64', format: 'tar.xz' },
  { system: 'Darwin', machine: 'x86_64', platform: 'darwin', arch: 'x64', format: 'tar.gz' },
  { system: 'Darwin', machine: 'arm64', platform: 'darwin', arch: 'arm64', format: 'tar.gz' },
];
const interruptStages = ['download', 'probe', 'payload'] as const;
const interruptSignals = [
  ['SIGHUP', 129],
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const;

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
  }, 30_000);

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

  it.each(
    interruptStages.flatMap((stage) =>
      interruptSignals.map(([signal, exitCode]) => ({ stage, signal, exitCode })),
    ),
  )('handles $signal during $stage with drained ownership', async ({ stage, signal, exitCode }) => {
    const subject = await scenario();
    const running = await subject.start({ ...linuxTarget, hold: stage });
    await subject.waitFor(`${stage}-held`);
    await subject.waitFor('watchdog-held');
    const child = await subject.stageIdentity(stage);
    const watchdog = await subject.watchdogIdentity();

    expect(child).toMatchObject({ invocation: subject.invocationId() });
    expect(child.pid).toBeGreaterThan(0);
    expect(watchdog).toMatchObject({ invocation: subject.invocationId() });
    expect(watchdog.pid).toBeGreaterThan(0);

    running.signal(signal);
    const result = await running.finish;

    expect({ exitCode: result.exitCode, signalCode: result.signalCode }).toEqual({
      exitCode,
      signalCode: null,
    });
    expect(result.finalLayout).toEqual([]);
    expect(result.receipt).toBeUndefined();
    expect(result.ownedResidue).toEqual([]);
    expect(await subject.lockSnapshot(linuxTarget)).toEqual([]);
    expect(await subject.processesAbsent([child.pid, watchdog.pid])).toBe(true);
  });

  it('handles HUP during a reused-target probe without downloading', async () => {
    const subject = await scenario();
    await subject.seedValidTarget(linuxTarget, 'probe');
    const before = await subject.finalSnapshot();
    const running = await subject.start({ ...linuxTarget, hold: 'probe' });
    await subject.waitFor('probe-held');
    await subject.waitFor('watchdog-held');
    const probe = await subject.stageIdentity('probe');

    running.signal('SIGHUP');
    const result = await running.finish;

    expect({ exitCode: result.exitCode, signalCode: result.signalCode }).toEqual({
      exitCode: 129,
      signalCode: null,
    });
    expect(result.downloadArgv).toEqual([]);
    expect(result.finalLayout).toEqual(['LAYOUT', 'bin', 'install-receipt.json']);
    expect(await subject.finalSnapshot()).toEqual(before);
    expect(await subject.lockSnapshot(linuxTarget)).toEqual([]);
    expect(await subject.processesAbsent([probe.pid])).toBe(true);
  });

  it('escalates a resistant payload after INT and repeated TERM without an orphan', async () => {
    const subject = await scenario();
    const running = await subject.start({
      ...linuxTarget,
      hold: 'payload',
      resistant: true,
    });
    await subject.waitFor('payload-held');
    await subject.waitFor('watchdog-held');
    const child = await subject.stageIdentity('payload');
    const watchdog = await subject.watchdogIdentity();

    running.signal('SIGINT');
    running.signal('SIGTERM');
    running.signal('SIGTERM');
    const result = await running.finish;

    expect({ exitCode: result.exitCode, signalCode: result.signalCode }).toEqual({
      exitCode: 130,
      signalCode: null,
    });
    expect(result.finalLayout).toEqual([]);
    expect(result.ownedResidue).toEqual([]);
    expect(await subject.processesAbsent([child.pid, watchdog.pid])).toBe(true);
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

  it.each(lateFailures)(
    'publishes nothing when the $failure step reports failure after it succeeded',
    async ({ failure, events }) => {
      const subject = await scenario();
      const result = await subject.run({ ...linuxTarget, failure });

      expect({ exitCode: result.exitCode, signalCode: result.signalCode }).toEqual({
        exitCode: 1,
        signalCode: null,
      });
      expect(result.events).toEqual(events);
      expect(result.finalLayout).toEqual([]);
      expect(result.receipt).toBeUndefined();
      expect(result.ownedResidue).toEqual([]);
      expect(result.hostileSentinel).toBe(false);
      expect(await subject.outsideSnapshot()).toEqual(subject.expectedOutsideSnapshot());
    },
  );

  it('terminates a download that outlives its bound and ignores termination', async () => {
    const subject = await scenario();
    const running = await subject.start({ ...linuxTarget, watchdog: 'download-hang' });
    await subject.waitFor('download');
    const held = Date.now();
    const result = await running.finish;

    expect(Date.now() - held).toBeLessThanOrEqual(3_500);
    expect({ exitCode: result.exitCode, signalCode: result.signalCode }).toEqual({
      exitCode: 1,
      signalCode: null,
    });
    expect(result.watchdogTermGrace).toBe(true);
    expect(result.events).toEqual(['download']);
    expect(result.finalLayout).toEqual([]);
    expect(result.receipt).toBeUndefined();
    expect(result.ownedResidue).toEqual([]);
    expect(await subject.outsideSnapshot()).toEqual(subject.expectedOutsideSnapshot());

    const observed = [await subject.heldChildPid(), await subject.watchdogPid()];
    expect(observed.map((pid) => Number.isSafeInteger(pid) && pid > 0)).toEqual([true, true]);
    expect(await subject.processesAbsent(observed)).toBe(true);
  });

  it('stages only under the install root while a hostile TMPDIR is offered', async () => {
    const subject = await scenario();
    const running = await subject.start({ ...linuxTarget, payload: 'held' });
    await subject.waitFor('payload-held');

    expect(await subject.stageRoots()).toEqual([
      expect.stringMatching(/^26\.8\.2\/linux-x64\.stage\.[^/]+$/u),
    ]);
    expect(await subject.stateOutsideStage()).toEqual([]);
    expect(await subject.outsideSnapshot()).toEqual(subject.expectedOutsideSnapshot());

    await subject.releasePayload();
    const result = await running.finish;

    expect(result.exitCode).toBe(0);
    expect(result.receipt).toEqual(subject.expectedReceipt(linuxTarget));
    expect(result.ownedResidue).toEqual([]);
    expect(result.hostileSentinel).toBe(false);
    expect(await subject.outsideSnapshot()).toEqual(subject.expectedOutsideSnapshot());
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

  it('keeps a held fresh install single-owner and leaves the owner lock unchanged', async () => {
    const subject = await scenario();
    const owner = await subject.start({ ...linuxTarget, hold: 'payload' });
    await subject.waitFor('payload-held');
    const before = await subject.lockSnapshot(linuxTarget);
    const contender = await subject.startContender(linuxTarget);
    const result = await contender.finish;

    expect(result.exitCode).not.toBe(0);
    expect(result.downloadArgv).toEqual([]);
    expect(result.events).toEqual([]);
    expect(await subject.lockSnapshot(linuxTarget)).toEqual(before);

    await subject.releasePayload();
    await owner.finish;
    expect(await subject.lockSnapshot(linuxTarget)).toEqual([]);
  });

  it('keeps a held reuse probe single-owner without changing the final target', async () => {
    const subject = await scenario();
    await subject.seedValidTarget(linuxTarget, 'probe');
    const before = await subject.finalSnapshot();
    const owner = await subject.start({ ...linuxTarget, hold: 'probe' });
    await subject.waitFor('probe-held');
    const lock = await subject.lockSnapshot(linuxTarget);
    const contender = await subject.startContender(linuxTarget);
    const result = await contender.finish;

    expect(result.exitCode).not.toBe(0);
    expect(result.downloadArgv).toEqual([]);
    expect(result.events).toEqual([]);
    expect(await subject.finalSnapshot()).toEqual(before);
    expect(await subject.lockSnapshot(linuxTarget)).toEqual(lock);

    owner.signal('SIGHUP');
    expect((await owner.finish).exitCode).toBe(129);
    expect(await subject.lockSnapshot(linuxTarget)).toEqual([]);
  });

  it.each<ExistingInstallLock>(['empty-dir', 'stale-dir', 'foreign-marker', 'file', 'symlink'])(
    'fails closed for a preexisting %s install lock',
    async (kind) => {
      const subject = await scenario();
      await subject.seedLock(kind, linuxTarget);
      const before = await subject.lockSnapshot(linuxTarget);
      const result = await subject.run(linuxTarget);
      expect(result.exitCode).not.toBe(0);
      expect(result.downloadArgv).toEqual([]);
      expect(result.ownedResidue).toEqual([]);
      expect(await subject.lockSnapshot(linuxTarget)).toEqual(before);
    },
  );

  it.each(['replace', 'delete'] as const)(
    'preserves a lock marker that changes during cleanup: %s',
    async (change) => {
      const subject = await scenario();
      const owner = await subject.start({ ...linuxTarget, hold: 'payload' });
      await subject.waitFor('payload-held');
      if (change === 'replace') {
        await subject.replaceLockMarker(linuxTarget);
      } else {
        await subject.deleteLockMarker(linuxTarget);
      }
      const expected = await subject.lockSnapshot(linuxTarget);
      await subject.releasePayload();
      expect((await owner.finish).exitCode).not.toBe(0);
      expect(await subject.lockSnapshot(linuxTarget)).toEqual(expected);
    },
  );

  it('releases the lock after a failure and reacquires it for the next invocation', async () => {
    const subject = await scenario();
    const failed = await subject.run({ ...linuxTarget, publishedSha256: 'divergent' });
    expect(failed.exitCode).toBe(1);
    expect(await subject.lockSnapshot(linuxTarget)).toEqual([]);
    const retried = await subject.run({ ...linuxTarget, publishedSha256: 'divergent' });
    expect(retried.exitCode).toBe(1);
    expect(retried.events.slice(-2)).toEqual(['download', 'sha256']);
  });

  it('runs a generated installer supplied directly on stdin for fresh and reuse paths', async () => {
    const fresh = await scenario();
    const freshResult = await (await fresh.startFromStdin(linuxTarget)).finish;
    expect(freshResult.events).toContain('probe-stdin-eof');
    expect(freshResult.events).toContain('payload-stdin-eof');
    expect(freshResult.exitCode).toBe(0);

    const reused = await scenario();
    await reused.seedValidTarget(linuxTarget);
    const reusedResult = await (await reused.startFromStdin(linuxTarget)).finish;
    expect(reusedResult.exitCode).toBe(0);
    expect(reusedResult.events).toEqual(['probe-stdin-eof', 'probe']);
  });

  it('executes exact generated bytes through absolute curl and shell over loopback', async () => {
    const fresh = await scenario();
    const freshRun = await fresh.startOverHttp(linuxTarget);
    const freshResult = await freshRun.finish;
    expect(freshResult.exitCode).toBe(0);
    expect(fresh.servedScript()).toBe(await fresh.generatedScript());
    expect(fresh.servedScriptChunks().length).toBeGreaterThan(1);
    expect(freshResult.events).toContain('probe-stdin-eof');

    const reused = await scenario();
    await reused.seedValidTarget(linuxTarget);
    const reusedResult = await (await reused.startOverHttp(linuxTarget)).finish;
    expect(reusedResult.exitCode).toBe(0);
    expect(reused.servedScript()).toBe(await reused.generatedScript());
    expect(reusedResult.events).toEqual(['probe-stdin-eof', 'probe']);
  });

  describe('hermetic spawned PATH', () => {
    const inheritedPath = process.env.PATH;
    let sentinelDir: string;
    let sentinelTouched: string;

    beforeEach(async () => {
      sentinelDir = await mkdtemp(join(tmpdir(), 'revo-b2a-sentinel-'));
      sentinelTouched = join(sentinelDir, 'sentinel-touched');
      const sentinelCurl = join(sentinelDir, 'curl');
      await writeFile(sentinelCurl, `#!/bin/sh\ntouch '${sentinelTouched}'\nexit 1\n`, {
        mode: 0o700,
      });
      await chmod(sentinelCurl, 0o700);
      process.env.PATH = `${sentinelDir}:${inheritedPath ?? ''}`;
    });

    afterEach(async () => {
      if (inheritedPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = inheritedPath;
      }
      await rm(sentinelDir, { recursive: true, force: true });
    });

    const sentinelUntouched = () =>
      lstat(sentinelTouched).then(
        () => false,
        () => true,
      );

    it('still uses the fixture curl argv with an ambient curl sentinel on the inherited PATH', async () => {
      const subject = await scenario();
      const result = await subject.run(linuxTarget);
      expect(result.exitCode).toBe(0);
      expect(result.downloadArgv).toEqual(
        subject.expectedDownloadArgv('curl', dirname(result.payloadPath)),
      );
      expect(await sentinelUntouched()).toBe(true);
    });

    it('falls back to the fixture wget without invoking an ambient curl sentinel', async () => {
      const subject = await scenario();
      const result = await subject.run({ ...linuxTarget, downloader: 'wget' });
      expect(result.exitCode).toBe(0);
      expect(result.downloadArgv).toEqual(
        subject.expectedDownloadArgv('wget', dirname(result.payloadPath)),
      );
      expect(result.events).toContain('download');
      expect(await sentinelUntouched()).toBe(true);
    });
  });
});
