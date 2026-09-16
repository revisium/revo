import { chmod, lstat, readFile, readlink, rm, writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readActivation } from '../../src/installation/activation-store.js';
import { activationScenario } from '../support/installation/activation-scenario.js';

describe('prepared installation activation', () => {
  it('activates one package and Node selection atomically', async () => {
    const data = await activationScenario();
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
      expect(await data.readEntrypoint()).toContain(current.record.toolchain.nodeRef);
    } finally {
      await data.cleanup();
    }
  });

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
      const competitor = await data.competitor();
      expect(competitor.status).toBe('busy');
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
});
