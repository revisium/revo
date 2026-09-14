import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OPERATION_ID,
  PUBLIC_URL,
  ServerLaunchAttemptScenario,
  startMessage,
  turn,
} from '../support/server/server-launch-attempt-scenario.js';

describe('detached server launch attempt', () => {
  afterEach(() => vi.useRealTimers());

  it('subscribes before boot and completes only after exact ready, commit, and acknowledgement', async () => {
    const scenario = await new ServerLaunchAttemptScenario().load();
    const result = scenario.start();
    expect(scenario.sent()).toEqual([]);

    scenario.booted();
    expect(scenario.process.subscribedBeforeFirstSend).toBe(true);
    expect(scenario.sent('start')).toEqual([startMessage()]);
    scenario.deliver('start');
    await Promise.resolve();
    scenario.ready();
    expect(scenario.sent('commit')).toEqual([
      { protocol: 'revo-server-host/v1', type: 'commit', operationId: OPERATION_ID },
    ]);
    scenario.deliver('commit');
    await Promise.resolve();
    scenario.committed();

    await expect(result).resolves.toEqual({ kind: 'started', url: PUBLIC_URL });
    expect(scenario.process.detachCommittedCalls).toBe(1);
    expect(scenario.process.stopCalls).toBe(0);
    expect(scenario.process.abandonUncertainCalls).toBe(0);
  });

  it.each(['abort', 'reject', 'timeout'] as const)(
    'stops and observes completion when %s wins before start delivery',
    async (failure) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const scenario = await new ServerLaunchAttemptScenario().load();
      const result = scenario.start(50);
      scenario.booted();
      if (failure === 'abort') {
        scenario.abort();
      }
      if (failure === 'reject') {
        scenario.reject('start');
      }
      if (failure === 'timeout') {
        await vi.advanceTimersByTimeAsync(50);
      }

      let settled = false;
      void result.then(
        () => (settled = true),
        () => (settled = true),
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(scenario.process.stopCalls).toBe(1);
      scenario.exit(0);
      await expect(result).rejects.toMatchObject({ code: expect.stringMatching(/^START_/u) });
      await expect(scenario.process.completion).resolves.toEqual({ exitCode: 0, signal: null });
      expect(scenario.process.detachCommittedCalls).toBe(0);
      expect(scenario.process.abandonUncertainCalls).toBe(0);
    },
  );

  it('returns unknown when commit delivery rejects after the start fence', async () => {
    const scenario = await new ServerLaunchAttemptScenario().load();
    const result = scenario.start();
    scenario.booted();
    scenario.deliver('start');
    await Promise.resolve();
    scenario.ready();
    scenario.reject('commit');

    await expect(result).rejects.toMatchObject({ code: 'START_OUTCOME_UNKNOWN' });
    expect(scenario.process.abandonUncertainCalls).toBe(1);
    expect(scenario.process.stopCalls).toBe(0);
    expect(scenario.process.detachCommittedCalls).toBe(0);
  });

  it('reports retained cleanup promptly when owned stop rejects before completion', async () => {
    const scenario = await new ServerLaunchAttemptScenario().load();
    scenario.process.holdStop();
    const result = scenario.start();
    scenario.booted();
    scenario.abort();
    await Promise.resolve();
    scenario.process.rejectStop();

    const error = await result.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'START_CANCELLED', cleanup: 'retained' });
    expect(String(error)).not.toContain('secret');
    expect(scenario.process.stopCalls).toBe(1);
    expect(scenario.process.detachCommittedCalls).toBe(0);
    expect(scenario.process.abandonUncertainCalls).toBe(0);
  });

  it.each(['ack-timeout', 'exit', 'abort'] as const)(
    'returns unknown and abandons local handles when %s follows delivered commit',
    async (failure) => {
      vi.useFakeTimers();
      vi.setSystemTime(20_000);
      const scenario = await new ServerLaunchAttemptScenario().load();
      const result = scenario.start(100);
      const outcome = result.then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
      scenario.booted();
      scenario.deliver('start');
      await Promise.resolve();
      scenario.ready();
      scenario.deliver('commit');
      await Promise.resolve();
      if (failure === 'exit') {
        scenario.exit(1);
      }
      if (failure === 'abort') {
        scenario.abort();
      }
      if (failure === 'ack-timeout') {
        await vi.advanceTimersByTimeAsync(100);
      }

      await expect(outcome).resolves.toMatchObject({
        kind: 'rejected',
        error: { code: 'START_OUTCOME_UNKNOWN' },
      });
      expect(scenario.process.abandonUncertainCalls).toBe(1);
      expect(scenario.process.stopCalls).toBe(0);
      expect(scenario.process.detachCommittedCalls).toBe(0);
    },
  );

  it('treats a successful start send callback as the cleanup ownership fence', async () => {
    const before = await new ServerLaunchAttemptScenario().load();
    const beforeResult = before.start();
    before.booted();
    before.abort();
    before.deliver('start');
    before.exit(0);
    await expect(beforeResult).rejects.not.toMatchObject({ code: 'START_OUTCOME_UNKNOWN' });
    expect(before.process.stopCalls).toBe(1);

    const after = await new ServerLaunchAttemptScenario().load();
    const afterResult = after.start();
    after.booted();
    after.deliver('start');
    await Promise.resolve();
    after.abort();
    await expect(afterResult).rejects.toMatchObject({ code: 'START_OUTCOME_UNKNOWN' });
    expect(after.process.stopCalls).toBe(0);
    expect(after.process.abandonUncertainCalls).toBe(1);
  });

  it.each([
    [
      'wrong operation',
      () => ({
        protocol: 'revo-server-host/v1',
        type: 'ready',
        operationId: 'f'.repeat(32),
        url: PUBLIC_URL,
      }),
    ],
    [
      'wrong URL',
      () => ({
        protocol: 'revo-server-host/v1',
        type: 'ready',
        operationId: OPERATION_ID,
        url: 'http://127.0.0.1:9999',
      }),
    ],
    [
      'malformed',
      () => ({
        protocol: 'revo-server-host/v1',
        type: 'ready',
        operationId: OPERATION_ID,
        secret: 'hidden',
      }),
    ],
  ] as const)('rejects %s readiness without disclosing private input', async (_name, message) => {
    const scenario = await new ServerLaunchAttemptScenario().load();
    const result = scenario.start();
    scenario.booted();
    scenario.deliver('start');
    await Promise.resolve();
    scenario.malformed(message());

    const error = await result.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'START_OUTCOME_UNKNOWN' });
    expect(String(error)).not.toContain('hidden');
    expect(scenario.process.stopCalls).toBe(0);
    expect(scenario.process.abandonUncertainCalls).toBe(1);
  });

  it('rejects duplicate boot before start delivery and waits for owned cleanup', async () => {
    const scenario = await new ServerLaunchAttemptScenario().load();
    const result = scenario.start();
    scenario.booted();
    scenario.booted();
    let settled = false;
    void result.then(
      () => (settled = true),
      () => (settled = true),
    );
    await turn();
    expect(settled).toBe(false);
    expect(scenario.process.stopCalls).toBe(1);
    scenario.exit(0);
    await expect(result).rejects.toMatchObject({ code: expect.stringMatching(/^START_/u) });
    expect(scenario.sent('start')).toHaveLength(1);
    expect(scenario.sent('commit')).toHaveLength(0);
  });

  it('rejects duplicate ready after the fence with at most one commit', async () => {
    const scenario = await new ServerLaunchAttemptScenario().load();
    const result = scenario.start();
    scenario.booted();
    scenario.deliver('start');
    await Promise.resolve();
    scenario.ready();
    scenario.ready();
    scenario.deliver('commit');
    await Promise.resolve();

    await expect(result).rejects.toMatchObject({ code: 'START_OUTCOME_UNKNOWN' });
    expect(scenario.sent('commit')).toHaveLength(1);
    expect(scenario.process.stopCalls).toBe(0);
    expect(scenario.process.abandonUncertainCalls).toBe(1);
  });

  it.each([
    ['SERVER_HOST_BUSY', undefined, 'START_BUSY', undefined],
    ['SERVER_HOST_FAILED', 'completed', 'START_FAILED', 'completed'],
    ['SERVER_HOST_FAILED', 'retained', 'START_OUTCOME_UNKNOWN', 'retained'],
    ['SERVER_HOST_FAILED', 'unconfirmed', 'START_OUTCOME_UNKNOWN', 'unconfirmed'],
    ['SERVER_HOST_FAILED', undefined, 'START_OUTCOME_UNKNOWN', undefined],
    ['SERVER_HOST_CANCELLED', undefined, 'START_OUTCOME_UNKNOWN', undefined],
    ['SERVER_HOST_INVALID_MESSAGE', undefined, 'START_OUTCOME_UNKNOWN', undefined],
    ['SERVER_HOST_WRONG_OPERATION', undefined, 'START_OUTCOME_UNKNOWN', undefined],
  ] as const)(
    'maps host failure %s/%s to %s without falsely claiming cleanup',
    async (hostCode, hostCleanup, publicCode, publicCleanup) => {
      const scenario = await new ServerLaunchAttemptScenario().load();
      const result = scenario.start();
      scenario.booted();
      scenario.deliver('start');
      await Promise.resolve();
      scenario.failed(hostCode, hostCleanup);

      const error = await result.catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: publicCode });
      const errorObject = typeof error === 'object' && error !== null ? error : {};
      expect(Reflect.get(errorObject, 'cleanup')).toBe(publicCleanup);
      expect(Object.prototype.hasOwnProperty.call(errorObject, 'cleanup')).toBe(
        publicCleanup !== undefined,
      );
      expect(scenario.process.stopCalls).toBe(0);
      expect(scenario.process.abandonUncertainCalls).toBe(1);
      expect(scenario.process.detachCommittedCalls).toBe(0);
    },
  );

  it('does not copy an unexpected cleanup field from a non-failed host outcome', async () => {
    const scenario = await new ServerLaunchAttemptScenario().load();
    const result = scenario.start();
    scenario.booted();
    scenario.deliver('start');
    await Promise.resolve();
    scenario.failed('SERVER_HOST_CANCELLED', 'completed');

    const error = await result.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'START_OUTCOME_UNKNOWN' });
    expect(error).not.toHaveProperty('cleanup');
    expect(scenario.process.abandonUncertainCalls).toBe(1);
    expect(scenario.process.stopCalls).toBe(0);
    expect(scenario.process.detachCommittedCalls).toBe(0);
  });

  it.each([
    [
      'wrong operation',
      { protocol: 'revo-server-host/v1', type: 'committed', operationId: 'f'.repeat(32) },
    ],
    [
      'malformed',
      {
        protocol: 'revo-server-host/v1',
        type: 'committed',
        operationId: OPERATION_ID,
        extra: true,
      },
    ],
  ] as const)(
    'returns unknown for %s committed acknowledgement',
    async (_name, acknowledgement) => {
      const scenario = await new ServerLaunchAttemptScenario().load();
      const result = scenario.start();
      scenario.booted();
      scenario.deliver('start');
      await Promise.resolve();
      scenario.ready();
      scenario.deliver('commit');
      await Promise.resolve();
      scenario.malformed(acknowledgement);

      await expect(result).rejects.toMatchObject({ code: 'START_OUTCOME_UNKNOWN' });
      expect(scenario.process.abandonUncertainCalls).toBe(1);
      expect(scenario.process.stopCalls).toBe(0);
      expect(scenario.process.detachCommittedCalls).toBe(0);
    },
  );

  it('settles one terminal transition when exit, abort, and a late message race', async () => {
    const scenario = await new ServerLaunchAttemptScenario().load();
    const result = scenario.start();
    const outcome = result.then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    scenario.booted();
    scenario.deliver('start');
    await Promise.resolve();
    scenario.exit(1);
    scenario.abort();
    scenario.ready();
    await turn();

    await expect(outcome).resolves.toMatchObject({
      kind: 'rejected',
      error: { code: 'START_OUTCOME_UNKNOWN' },
    });
    expect(scenario.process.abandonUncertainCalls).toBe(1);
    expect(scenario.process.stopCalls).toBe(0);
    expect(scenario.sent('commit')).toHaveLength(0);
  });
});
