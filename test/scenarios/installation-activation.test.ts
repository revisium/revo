import { chmod, lstat, readFile, readlink, rm, writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readActivation } from '../../src/installation/activation-store.js';
import { activationLauncherScenario } from '../support/installation/activation-launcher-scenario.js';
import { activationScenario } from '../support/installation/activation-scenario.js';

describe('prepared installation activation', () => {
  it('activates one package and Node selection atomically', async () => {
    const data = await activationLauncherScenario();
    try {
      const result = await data.activate();
      expect(result.status).toBe('activated');
      const current = await readActivation(data.channelRoot);
      expect(current.status).toBe('valid');
      if (current.status !== 'valid') {
        throw new Error('activation was not published');
      }
      expect(current.record.packageRef).toContain('package/');
      expect(current.record.toolchain.nodeRef).toContain('node/');
      expect(await data.packageBinMode()).toBe(0o600);
      const run = await data.executeCurrent(['arg with space', "apostrophe's", '']);
      expect(run).toMatchObject({ code: 0, signal: null });
      expect(run.run).toEqual({
        execPath: `${data.channelRoot}/${current.record.toolchain.nodeRef}/bin/node`,
        argv: ['arg with space', "apostrophe's", ''],
        cwd: expect.stringContaining("cwd with 'quote"),
      });
      expect(await data.readEntrypoint()).toContain(current.record.packageBin);
    } finally {
      await data.cleanup();
    }
  }, 40_000);
  it('returns unchanged without writes for the healthy active identity', async () => {
    const data = await activationScenario();
    try {
      await data.activate();
      const before = await data.snapshot();
      expect((await data.activate()).status).toBe('unchanged');
      expect(await data.snapshot()).toEqual(before);
    } finally {
      await data.cleanup();
    }
  });
  it('switches A to B without mixing package and Node generations', async () => {
    const data = await activationScenario();
    try {
      await data.activate();
      const first = await data.currentGeneration();
      await data.activateNext();
      const second = await data.currentGeneration();
      expect(second).not.toBe(first);
      const current = await readActivation(data.channelRoot);
      expect(current.status).toBe('valid');
      if (current.status !== 'valid') {
        throw new Error('next activation was not published');
      }
      expect(current.record.previousGeneration).toBe(first);
      expect(current.record.packageRef).toContain(data.next.plan.release.version);
      expect(current.record.toolchain.nodeRef).toContain(data.next.plan.toolchain.node);
      expect(await lstat(data.previousTarget())).toBeTruthy();
    } finally {
      await data.cleanup();
    }
  });
  it('rejects a competitor and precommit cancellation without changing current', async () => {
    const data = await activationScenario();
    try {
      await data.activate();
      const before = await data.currentGeneration();
      expect((await data.competitor()).status).toBe('busy');
      expect(await data.currentGeneration()).toBe(before);
      const controller = new AbortController();
      controller.abort();
      expect((await data.activate({ signal: controller.signal })).status).toBe('cancelled');
      expect(await data.currentGeneration()).toBe(before);
    } finally {
      await data.cleanup();
    }
  });
  it('reports invalid and unavailable state without touching prior data', async () => {
    const data = await activationScenario();
    try {
      expect((await readActivation(`${data.root}/missing`)).status).toBe('unavailable');
      await data.activate();
      await rm(data.currentPath);
      await writeFile(data.currentPath, 'not-a-link');
      expect((await readActivation(data.channelRoot)).status).toBe('invalid');
      expect(await readFile(data.userData, 'utf8')).toBe('keep');
    } finally {
      await data.cleanup();
    }
  });
  it('rejects unsafe generation files and preserves the previous generation', async () => {
    const data = await activationScenario();
    try {
      await data.activate();
      const before = await data.currentGeneration();
      await chmod(`${await data.currentGenerationPath()}/activation.json`, 0o644);
      expect((await readActivation(data.channelRoot)).status).toBe('invalid');
      expect(await readlink(data.currentPath)).toBe(`activations/${before}`);
    } finally {
      await data.cleanup();
    }
  });

  it('accepts readable package modes and preserves child exit and signal', async () => {
    const data = await activationLauncherScenario();
    try {
      await data.activate();
      expect((await data.executeCurrent([], { REVO_ACTIVATION_EXIT7: '1' })).code).toBe(7);
      expect((await data.executeCurrent([], { REVO_ACTIVATION_TERM: '1' })).signal).toBe('SIGTERM');
    } finally {
      await data.cleanup();
    }
  }, 40_000);

  it('accepts private toolchain modes and rejects unsafe modes for Node and pnpm', async () => {
    const data = await activationScenario();
    try {
      await data.setNodeMode(0o500);
      await data.setPnpmMode(0o500);
      expect((await data.activate()).status).toBe('activated');
      await data.setNodeMode(0o755);
      await data.setPnpmMode(0o755);
      expect((await readActivation(data.channelRoot)).status).toBe('valid');
      const unsafeModes = [0o600, 0o401, 0o100, 0o720, 0o702, 0o4700, 0o2700, 0o1700];
      const checkUnsafe = (setMode: (mode: number) => Promise<void>) =>
        unsafeModes.reduce(async (previous, mode) => {
          await previous;
          await setMode(mode);
          expect((await readActivation(data.channelRoot)).status).toBe('invalid');
        }, Promise.resolve());
      await checkUnsafe(data.setNodeMode);
      await data.setNodeMode(0o755);
      expect((await readActivation(data.channelRoot)).status).toBe('valid');
      await checkUnsafe(data.setPnpmMode);
      await data.setPnpmMode(0o755);
      expect((await readActivation(data.channelRoot)).status).toBe('valid');
    } finally {
      await data.cleanup();
    }
  });

  it('rejects unsafe package files and a tampered launcher without mutation', async () => {
    const data = await activationScenario();
    try {
      await data.activate();
      const before = await data.currentGeneration();
      await data.setPackageBinMode(0o622);
      expect((await readActivation(data.channelRoot)).status).toBe('invalid');
      await data.setPackageBinMode(0o755);
      expect((await readActivation(data.channelRoot)).status).toBe('valid');
      await data.tamperLauncher();
      expect((await readActivation(data.channelRoot)).status).toBe('invalid');
      expect(await readlink(data.currentPath)).toBe(`activations/${before}`);
    } finally {
      await data.cleanup();
    }
  });

  it('rejects a package-bin symlink and preserves user data', async () => {
    const data = await activationScenario();
    try {
      await data.activate();
      await data.tamperPackageBin();
      expect((await readActivation(data.channelRoot)).status).toBe('invalid');
      expect(await readFile(data.userData, 'utf8')).toBe('keep');
    } finally {
      await data.cleanup();
    }
  });

  it('rejects a candidate whose declared package bin does not match', async () => {
    const data = await activationScenario();
    try {
      await expect(
        data.activateCandidate({ ...data.first, packageBin: 'dist/bin/other.js' }),
      ).rejects.toThrow('package bin differs');
    } finally {
      await data.cleanup();
    }
  });

  it('rejects a package-bin ancestor symlink without repairing it', async () => {
    const data = await activationScenario();
    try {
      await data.activate();
      await data.tamperPackageBinAncestor();
      expect((await readActivation(data.channelRoot)).status).toBe('invalid');
      expect((await lstat(`${data.first.packageDirectory}/bin`)).isSymbolicLink()).toBe(true);
    } finally {
      await data.cleanup();
    }
  });
});
