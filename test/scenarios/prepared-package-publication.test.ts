import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { installerPackageScenario } from '../support/installation/installer-package-scenario.js';

describe('prepared package publication', () => {
  it('reuses a compatible winner and leaves a fresh attempt intact', async () => {
    const data = await installerPackageScenario();
    try {
      await data.publish();
      const attempt = await data.prepareAttempt('second');
      const winner = await data.publishAttempt(attempt);
      expect(winner.directory).toBe(data.target);
      expect(await data.inspectAttempt(attempt)).toBe(true);
      expect(await data.readPublishedPackage()).toBe(data.target);
    } finally {
      await data.cleanup();
    }
  });

  it('converges two real publisher processes on one immutable winner', async () => {
    const data = await installerPackageScenario();
    try {
      const attempts = await Promise.all([
        data.prepareAttempt('process-a'),
        data.prepareAttempt('process-b'),
      ]);
      const results = await data.publishTogether(attempts);
      expect(results).toHaveLength(2);
      expect(results.every((result) => result.ok && result.directory === data.target)).toBe(true);
      expect(await data.readPublishedPackage()).toBe(data.target);
    } finally {
      await data.cleanup();
    }
  });

  it('rejects an incompatible target without deleting either side', async () => {
    const data = await installerPackageScenario();
    try {
      await data.publishCompetitorBeforeCommit({ corrupt: true });
      const attempt = await data.prepareAttempt('loser');
      await expect(data.publishAttempt(attempt)).rejects.toThrow(
        'prepared package: existing target is incompatible',
      );
      expect(await data.inspectAttempt(attempt)).toBe(true);
      expect(await data.snapshotWinner()).toBe('foreign');
    } finally {
      await data.cleanup();
    }
  });

  it('keeps invalid attempts private', async () => {
    const data = await installerPackageScenario();
    try {
      const attempt = await data.prepareAttempt('invalid', { invalid: true });
      await expect(data.publishAttempt(attempt)).rejects.toThrow(/stage/iu);
      expect(await data.inspectAttempt(attempt)).toBe(true);
      expect(await data.readPublishedPackage()).toBeUndefined();
    } finally {
      await data.cleanup();
    }
  });

  it('keeps a caller stage after a same-filesystem publication fault', async () => {
    const data = await installerPackageScenario();
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...fs,
      rename: async () => {
        const error = Object.assign(new Error('fault'), { code: 'EXDEV' });
        throw error;
      },
    }));
    try {
      vi.resetModules();
      const prepared = await import('../../src/installation/prepared-package.js');
      await expect(
        prepared.publishPreparedPackage({
          plan: data.plan,
          stage: data.stage,
          channelRoot: data.channelRoot,
        }),
      ).rejects.toThrow('prepared package: atomic publication crossed filesystems');
      expect(await data.inspectAttempt({ stage: data.stage })).toBe(true);
      expect(await data.readPublishedPackage()).toBeUndefined();
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
      await data.cleanup();
    }
  });

  it('reports unavailable paths and valid receipts from another plan', async () => {
    const data = await installerPackageScenario();
    try {
      await data.publish();
      const receipt = JSON.parse(await data.readReceipt());
      receipt.release.version = '9.9.9';
      await writeFile(`${data.target}/install-receipt.json`, `${JSON.stringify(receipt)}\n`);
      await expect(data.reuse()).rejects.toThrow('prepared package: receipt does not match plan');
      receipt.release.version = data.plan.release.version;
      await writeFile(`${data.target}/install-receipt.json`, `${JSON.stringify(receipt)}\n`);
      await chmod(data.target, 0o000);
      await expect(data.reuse()).rejects.toThrow('prepared package: receipt is unavailable');
    } finally {
      await chmod(data.target, 0o755).catch(() => undefined);
      await data.cleanup();
    }
  });

  it('does not expose inaccessible package data or target ancestors', async () => {
    const data = await installerPackageScenario();
    try {
      await data.publish();
      await chmod(`${data.target}/package.json`, 0o000);
      await expect(data.reuse()).rejects.toThrow('prepared package: package identity is invalid');
      await chmod(`${data.target}/package.json`, 0o644);
      await writeFile(`${data.target}/package.json`, '{broken');
      await expect(data.reuse()).rejects.toThrow('prepared package: package identity is invalid');
      const versionDirectory = join(data.channelRoot, 'package', data.plan.release.version);
      await chmod(versionDirectory, 0o000);
      await expect(data.reuse()).rejects.toThrow('prepared package: target is unavailable');
      const attempt = await data.prepareAttempt('ancestor');
      await expect(data.publishAttempt(attempt)).rejects.toThrow(
        'prepared package: target is unavailable',
      );
    } finally {
      await chmod(`${data.target}/package.json`, 0o644).catch(() => undefined);
      await chmod(join(data.channelRoot, 'package', data.plan.release.version), 0o755).catch(
        () => undefined,
      );
      await data.cleanup();
    }
  });

  it('refuses a caller stage that already contains a receipt', async () => {
    const data = await installerPackageScenario();
    try {
      await writeFile(`${data.stage}/install-receipt.json`, '{}\n');
      await expect(data.publish()).rejects.toThrow(
        'prepared package: stage receipt is unavailable',
      );
      expect(await data.inspectAttempt({ stage: data.stage })).toBe(true);
      expect(await data.readPublishedPackage()).toBeUndefined();
    } finally {
      await data.cleanup();
    }
  });

  it('fails closed when the stage or target parent becomes unavailable', async () => {
    const data = await installerPackageScenario();
    const packageParent = join(data.channelRoot, 'package');
    try {
      await chmod(data.root, 0o000);
      await expect(data.publish()).rejects.toThrow('prepared package: stage is unavailable');
      await chmod(data.root, 0o755);
      await mkdir(packageParent);
      await chmod(packageParent, 0o000);
      await expect(data.publish()).rejects.toThrow(
        'prepared package: target ancestor is unavailable',
      );
    } finally {
      await chmod(data.root, 0o755).catch(() => undefined);
      await chmod(packageParent, 0o755).catch(() => undefined);
      await data.cleanup();
    }
  });

  it('keeps a valid stage when a required stage file is absent', async () => {
    const data = await installerPackageScenario();
    try {
      await rm(join(data.stage, 'package.json'));
      await expect(data.publish()).rejects.toThrow('prepared package: stage is invalid');
      expect(await data.inspectAttempt({ stage: data.stage })).toBe(true);
    } finally {
      await data.cleanup();
    }
  });

  it('reuses a compatible winner that appears during the atomic rename', async () => {
    const data = await installerPackageScenario();
    const winner = await data.prepareAttempt('race-winner');
    const loser = await data.prepareAttempt('race-loser');
    await writeFile(
      join(winner.stage, 'install-receipt.json'),
      `${JSON.stringify(data.receipt)}\n`,
      { mode: 0o600 },
    );
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let raced = false;
    vi.doMock('node:fs/promises', () => ({
      ...fs,
      rename: async (from: string, to: string) => {
        if (!raced && to === data.target) {
          raced = true;
          await fs.rename(winner.stage, to);
          throw Object.assign(new Error('collision'), { code: 'EEXIST' });
        }
        return fs.rename(from, to);
      },
    }));
    try {
      vi.resetModules();
      const prepared = await import('../../src/installation/prepared-package.js');
      const result = await prepared.publishPreparedPackage({
        plan: data.plan,
        stage: loser.stage,
        channelRoot: data.channelRoot,
      });
      expect(result.directory).toBe(data.target);
      expect(await data.inspectAttempt(loser)).toBe(true);
      expect(await data.readPublishedPackage()).toBe(data.target);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
      await data.cleanup();
    }
  });

  it('converges when parent creation races with an existing directory', async () => {
    const data = await installerPackageScenario();
    const packageParent = join(data.channelRoot, 'package');
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let raced = false;
    vi.doMock('node:fs/promises', () => ({
      ...fs,
      mkdir: async (path: string, options: Parameters<typeof fs.mkdir>[1]) => {
        if (!raced && path === packageParent) {
          raced = true;
          await fs.mkdir(path, options);
          throw Object.assign(new Error('parent race'), { code: 'EEXIST' });
        }
        return fs.mkdir(path, options);
      },
    }));
    try {
      vi.resetModules();
      const prepared = await import('../../src/installation/prepared-package.js');
      const result = await prepared.publishPreparedPackage({
        plan: data.plan,
        stage: data.stage,
        channelRoot: data.channelRoot,
      });
      expect(result.directory).toBe(data.target);
      expect(await data.readPublishedPackage()).toBe(data.target);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
      await data.cleanup();
    }
  });
});
