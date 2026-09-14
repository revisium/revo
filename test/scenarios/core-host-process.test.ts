import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CoreHostProcessScenario } from '../support/core-host/core-host-process-scenario.js';

describe('Core host process resource', () => {
  let scenario: CoreHostProcessScenario;

  beforeEach(async () => {
    scenario = await new CoreHostProcessScenario().setup();
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it('serializes stage callbacks and drains them before returning the listening child', async () => {
    const resource = scenario.resource('cooperative');
    const calls: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => (releaseFirst = resolve));
    const starting = scenario.start(resource, {
      onStage: async (stage) => {
        calls.push(`${stage.status}:entered`);
        if (stage.status === 'started') {
          await first;
        }
        calls.push(`${stage.status}:completed`);
      },
    });

    await until(() => calls.length === 1);
    expect(calls).toEqual(['started:entered']);
    expect(await observedSettlement(starting)).toBe('pending');
    releaseFirst?.();

    await expect(starting).resolves.toMatchObject({ type: 'listening', port: 43210 });
    expect(calls).toEqual([
      'started:entered',
      'started:completed',
      'completed:entered',
      'completed:completed',
    ]);
    expect(() => resource.assertRunning()).not.toThrow();
  });

  it('aborts after spawn but before boot and confirms the owned child exit', async () => {
    const resource = scenario.resource('delayed-boot');
    const controller = new AbortController();
    const starting = scenario.start(resource, { signal: controller.signal });
    await scenario.waitForBootBlock();

    controller.abort();

    await expect(starting).rejects.toMatchObject({ code: 'revo.core-host.aborted' });
    await expect(resource.settled()).resolves.toEqual({ exitCode: 0, signal: null });
    expect(() => resource.assertRunning()).toThrowError(Error);
  });

  it.each([
    { name: 'pre-aborted', signal: () => AbortSignal.abort(), deadline: () => Date.now() + 1_000 },
    { name: 'expired', signal: () => new AbortController().signal, deadline: () => Date.now() - 1 },
  ])('does not spawn for a $name start request', async ({ signal, deadline }) => {
    const controlled = scenario.controlled(true);

    await expect(
      controlled.resource.start(
        {
          protocol: 'revo-core-host/v1',
          type: 'start',
          databaseUrl: 'postgresql://explicit.invalid/revo',
          temporaryWorkingDirectoryRoot: '/tmp',
          agentWorkspaceDirectory: '/tmp',
          host: '127.0.0.1',
          port: 0,
        },
        { signal: signal(), deadline: deadline(), onStage: () => Promise.resolve() },
      ),
    ).rejects.toMatchObject({ code: expect.stringContaining('revo.core-host') });
    expect(controlled.processes.startCalls).toBe(0);
    await expect(scenario.close(controlled.resource)).resolves.toBeUndefined();
    await expect(controlled.resource.completionState()).resolves.toEqual({
      kind: 'not-spawned',
    });
  });

  it('bounds pending-spawn abort and retains cleanup ownership', async () => {
    const controlled = scenario.controlled(true);
    const controller = new AbortController();
    const starting = scenario
      .start(controlled.resource, { signal: controller.signal })
      .catch((error: unknown) => error);
    controller.abort();

    expect(await observedSettlement(starting)).toBe('settled');
    await expect(starting).resolves.toMatchObject({ code: 'revo.core-host.aborted' });
    controlled.processes.release();
    await until(() => controlled.processes.stopCalls > 0);
    await expect(controlled.resource.settled()).resolves.toEqual({
      exitCode: null,
      signal: 'SIGTERM',
    });
  });

  it('closes a definitively rejected spawn as not spawned', async () => {
    const controlled = scenario.controlled(false, false, false, true);

    await expect(scenario.start(controlled.resource)).rejects.toMatchObject({
      code: expect.stringContaining('revo.core-host'),
    });
    await expect(scenario.close(controlled.resource)).resolves.toBeUndefined();
    await expect(controlled.resource.completionState()).resolves.toEqual({
      kind: 'not-spawned',
    });
  });

  it('latches a rejected stage callback and stops before listening is accepted', async () => {
    const resource = scenario.resource('cooperative');

    await expect(
      scenario.start(resource, {
        onStage: () => Promise.reject(new Error('private journal failure')),
      }),
    ).rejects.toMatchObject({ code: 'revo.core-host.stage' });
    await expect(resource.settled()).resolves.toEqual({ exitCode: 0, signal: null });
    expect(() => resource.assertRunning()).toThrowError(Error);
  });

  it.each(['late-stage-after-listening', 'duplicate-listening'] as const)(
    'rejects %s while draining an earlier stage callback',
    async (mode) => {
      const resource = scenario.resource(mode);
      let releaseStage: (() => void) | undefined;
      const blockedStage = new Promise<void>((resolve) => (releaseStage = resolve));
      const starting = scenario.start(resource, { onStage: () => blockedStage });

      await expect(starting).rejects.toMatchObject({ code: 'revo.core-host.protocol' });
      expect(() => resource.assertRunning()).toThrowError(
        expect.objectContaining({ code: 'revo.core-host.exited' }),
      );
      releaseStage?.();
      await expect(resource.settled()).resolves.toEqual({ exitCode: 0, signal: null });
    },
  );

  it('owns a late spawn after close times out and stops it when registration completes', async () => {
    const controlled = scenario.controlled(true, false, true);
    const starting = scenario.start(controlled.resource).catch((error: unknown) => error);

    await expect(scenario.close(controlled.resource, 20)).rejects.toMatchObject({
      code: 'revo.core-host.stop',
    });
    controlled.processes.release();
    await until(() => controlled.processes.stopCalls === 1);
    await expect(scenario.close(controlled.resource)).resolves.toBeUndefined();
    await expect(controlled.resource.settled()).resolves.toEqual({
      exitCode: null,
      signal: 'SIGTERM',
    });
    await expect(starting).resolves.toMatchObject({
      code: expect.stringContaining('revo.core-host'),
    });
    expect(controlled.processes.stopCalls).toBeGreaterThan(0);
  });

  it('bounds a held IPC send and confirms cleanup of the tracked child', async () => {
    const controlled = scenario.controlled(false, true);

    await expect(scenario.start(controlled.resource)).rejects.toMatchObject({
      code: 'revo.core-host.deadline',
    });
    await expect(controlled.resource.settled()).resolves.toEqual({
      exitCode: null,
      signal: 'SIGTERM',
    });
  });

  it.each(['early-listening', 'failed-then-listening'] as const)(
    'rejects the %s handshake sequence without accepting readiness',
    async (mode) => {
      const resource = scenario.resource(mode);
      await expect(scenario.start(resource)).rejects.toMatchObject({
        code: mode === 'early-listening' ? 'revo.core-host.protocol' : 'revo.core-host.failed',
      });
      expect(() => resource.assertRunning()).toThrowError(Error);
    },
  );

  it.each(['exit-before-boot', 'exit-before-listening'] as const)(
    'rejects when the child %s',
    async (mode) => {
      const resource = scenario.resource(mode);
      await expect(scenario.start(resource)).rejects.toMatchObject({
        code: 'revo.core-host.exited',
      });
      await expect(resource.settled()).resolves.toMatchObject({ exitCode: expect.any(Number) });
    },
  );

  it('retains one handle and retries close after a failed stop observation', async () => {
    const resource = scenario.resource('resistant', true);
    await scenario.start(resource);

    await expect(scenario.close(resource)).rejects.toMatchObject({ code: 'revo.core-host.stop' });
    expect(await scenario.spawnCount()).toBe(1);
    await expect(scenario.close(resource)).resolves.toBeUndefined();
    await expect(resource.settled()).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' });
    expect(await scenario.spawnCount()).toBe(1);
  });

  it('allows delayed private shutdown to complete before sending TERM', async () => {
    const resource = scenario.resource('delayed-shutdown');
    await scenario.start(resource);

    await scenario.close(resource);

    await expect(resource.settled()).resolves.toEqual({ exitCode: 0, signal: null });
    await expect(scenario.termWasReceived()).resolves.toBe(false);
  });

  it('closes without waiting for a blocked stage callback and exposes actual settlement', async () => {
    const resource = scenario.resource('resistant');
    let stageEntered = false;
    let releaseStage: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => (releaseStage = resolve));
    const starting = scenario.start(resource, {
      onStage: async () => {
        stageEntered = true;
        await blocked;
      },
    });
    await until(() => stageEntered);

    await expect(scenario.close(resource)).resolves.toBeUndefined();
    await expect(resource.settled()).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' });
    releaseStage?.();
    await expect(starting).rejects.toMatchObject({
      code: expect.stringContaining('revo.core-host'),
    });
  });

  it('detects a natural exit after listening and later caller journal work', async () => {
    const resource = scenario.resource('exit-after-listening');
    await scenario.start(resource);
    await resource.settled();
    await Promise.resolve();
    expect(() => resource.assertRunning()).toThrowError(
      expect.objectContaining({ code: 'revo.core-host.exited' }),
    );
  });
});

async function until(predicate: () => boolean, deadline = Date.now() + 1_000): Promise<void> {
  if (predicate()) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error('Expected transition was not observed');
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  await until(predicate, deadline);
}

const observedSettlement = <T>(operation: Promise<T>) =>
  Promise.race([
    operation.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    new Promise<'pending'>((resolvePending) => setTimeout(() => resolvePending('pending'), 20)),
  ]);
