import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProgressOperation } from '../../src/progress/index.js';
import type { ServerProgressSink } from '../../src/server/server-startup-observer.js';
import { PUBLIC_URL } from '../support/server/server-launch-attempt-scenario.js';
import { ServerStartupObserverScenario } from '../support/server/server-startup-observer-scenario.js';

describe('startup journal observation of a real launch attempt', () => {
  let scenario: ServerStartupObserverScenario;
  afterEach(async () => {
    await scenario?.close();
  });

  it('replays bursts once, preserves cursor gaps, and gates ready on ACK and detach', async () => {
    scenario = await new ServerStartupObserverScenario().open();
    scenario.operation.start('postgres-start');
    scenario.operation.progress('postgres-start', { counters: { bytesReceived: 1 } });
    scenario.operation.progress('postgres-start', { counters: { bytesReceived: 2 } });
    scenario.operation.complete('postgres-start');
    await scenario.publish();
    const result = scenario.start();
    await vi.waitFor(() =>
      expect(scenario.events.map((event) => event.sequence)).toEqual([1, 3, 4]),
    );
    scenario.attempt.process.holdDetach();
    await scenario.ready();
    await vi.waitFor(() => expect(scenario.observedReady).toBe(true));
    expect(scenario.events.some((event) => event.status === 'ready')).toBe(false);
    scenario.attempt.committed();
    await vi.waitFor(() => expect(scenario.attempt.process.detachCommittedCalls).toBe(1));
    expect(scenario.events.some((event) => event.status === 'ready')).toBe(false);
    scenario.attempt.process.settleDetach();
    await expect(result).resolves.toEqual({ kind: 'started', url: PUBLIC_URL });
    expect(scenario.events.map((event) => event.sequence)).toEqual([1, 3, 4, 5]);
    expect(scenario.attempt.process.listenerCount()).toBe(0);
  });

  it.each(['missing', 'malformed', 'foreign'] as const)(
    'ignores %s history without adopting another operation',
    async (state) => {
      scenario = await new ServerStartupObserverScenario().open();
      if (state === 'malformed') {
        await scenario.malformed();
      }
      if (state === 'foreign') {
        const foreign = new ProgressOperation({ operationId: 'f'.repeat(32), now: () => 0 });
        foreign.ready({ url: PUBLIC_URL });
        await scenario.publish(foreign, 'f'.repeat(32));
      }
      const result = scenario.start();
      await vi.waitFor(() => expect(scenario.reads).toBeGreaterThanOrEqual(2));
      expect(scenario.events).toEqual([]);
      await scenario.ready();
      scenario.attempt.committed();
      await expect(result).resolves.toMatchObject({ kind: 'started' });
      expect(scenario.events).toEqual([expect.objectContaining({ sequence: 1, status: 'ready' })]);
    },
  );

  it.each(['cancel', 'detach'] as const)(
    'never emits buffered ready after %s failure',
    async (failure) => {
      scenario = await new ServerStartupObserverScenario().open();
      const result = scenario.start();
      scenario.attempt.process.holdDetach();
      await scenario.ready();
      await vi.waitFor(() => expect(scenario.observedReady).toBe(true));
      if (failure === 'cancel') {
        scenario.attempt.abort();
      } else {
        scenario.attempt.committed();
        scenario.attempt.process.settleDetach(true);
      }
      await expect(result).rejects.toMatchObject({ code: 'START_OUTCOME_UNKNOWN' });
      expect(scenario.events).toEqual([]);
      expect(scenario.attempt.process.stopCalls).toBe(0);
      expect(scenario.attempt.process.abandonUncertainCalls).toBe(1);
      expect(scenario.attempt.process.listenerCount()).toBe(0);
    },
  );

  it.each(['throw', 'reject', 'hang'] as const)(
    'disables a sink on %s without disrupting commit',
    async (failure) => {
      scenario = await new ServerStartupObserverScenario().open();
      scenario.operation.start('server-start');
      await scenario.publish();
      const sink = vi.fn<ServerProgressSink>(() => {
        if (failure === 'throw') {
          throw new Error('private output failure');
        }
        return failure === 'reject'
          ? Promise.reject(new Error('private'))
          : new Promise<void>(() => undefined);
      });
      const result = scenario.start(sink);
      await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
      await scenario.ready();
      scenario.attempt.committed();
      await expect(result).rejects.toMatchObject({ code: 'START_PROGRESS_OUTPUT_FAILED' });
      expect(sink).toHaveBeenCalledTimes(1);
      expect(scenario.attempt.process.detachCommittedCalls).toBe(1);
      expect(scenario.attempt.process.stopCalls).toBe(0);
      expect(scenario.attempt.process.abandonUncertainCalls).toBe(0);
    },
  );

  it('keeps startup failure and cleanup primary when the sink also fails', async () => {
    scenario = await new ServerStartupObserverScenario().open();
    scenario.operation.start('server-start');
    await scenario.publish();
    const sink = vi.fn<ServerProgressSink>(() => {
      throw new Error('private output failure');
    });
    const result = scenario.start(sink);
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
    scenario.attempt.booted();
    scenario.attempt.deliver('start');
    await Promise.resolve();
    scenario.attempt.failed('SERVER_HOST_FAILED', 'completed');
    await expect(result).rejects.toMatchObject({ code: 'START_FAILED', cleanup: 'completed' });
  });
});
