import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProgressOperation } from '../../src/progress/index.js';
import type { ServerProgressSink } from '../../src/server/server-startup-observer.js';
import { OPERATION_ID, PUBLIC_URL } from '../support/server/server-launch-attempt-scenario.js';
import {
  FAST,
  JOURNAL_WARNING,
  OUTPUT_WARNING,
  ServerStartupObserverScenario,
} from '../support/server/server-startup-observer-scenario.js';

describe('startup journal observation of a real launch attempt', () => {
  let scenario: ServerStartupObserverScenario;
  afterEach(async () => {
    await scenario?.close();
  });

  it('replays bursts once, preserves cursor gaps, and gates ready on ACK and detach', async () => {
    scenario = await new ServerStartupObserverScenario().open();
    scenario.operation.start('postgres-start');
    scenario.operation.progress('postgres-start', { stageElapsedMs: 1 });
    scenario.operation.progress('postgres-start', { stageElapsedMs: 2 });
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
    'skips progress output that fails by %s and still reports the committed start',
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
      const result = scenario.start(sink, { timing: FAST });
      await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
      await scenario.ready();
      scenario.attempt.committed();
      await expect(result).resolves.toEqual({ kind: 'started', url: PUBLIC_URL });
      expect(sink).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready' }));
      expect(scenario.warnings).toEqual([OUTPUT_WARNING]);
      expect(scenario.attempt.process.detachCommittedCalls).toBe(1);
      expect(scenario.attempt.process.stopCalls).toBe(0);
      expect(scenario.attempt.process.abandonUncertainCalls).toBe(0);
    },
  );

  it.each(['fail', 'hang'] as const)(
    'reports the committed start with a synthesized ready when journal reads %s',
    async (read) => {
      scenario = await new ServerStartupObserverScenario().open();
      const result = scenario.start(undefined, { read, timing: FAST });
      await scenario.readyOverIpcOnly();
      scenario.attempt.committed();

      await expect(result).resolves.toEqual({ kind: 'started', url: PUBLIC_URL });
      expect(scenario.events).toEqual([
        expect.objectContaining({ operationId: OPERATION_ID, sequence: 1, status: 'ready' }),
      ]);
      expect(scenario.warnings).toEqual([JOURNAL_WARNING]);
    },
  );

  it('continues the journal sequence when the journal never records ready', async () => {
    scenario = await new ServerStartupObserverScenario().open();
    scenario.operation.start('postgres-start');
    scenario.operation.complete('postgres-start');
    await scenario.publish();
    const result = scenario.start();
    await vi.waitFor(() => expect(scenario.events).toHaveLength(2));
    await scenario.readyOverIpcOnly();
    scenario.attempt.committed();

    await expect(result).resolves.toEqual({ kind: 'started', url: PUBLIC_URL });
    const [, completed, ready] = scenario.events;
    expect(ready).toMatchObject({ sequence: 3, status: 'ready', url: PUBLIC_URL });
    expect(ready?.elapsedMs).toBeGreaterThanOrEqual(completed?.elapsedMs ?? 0);
    expect(scenario.warnings).toEqual([]);
  });

  it('gives the final ready delivery seconds instead of a quarter second', async () => {
    scenario = await new ServerStartupObserverScenario().open();
    const sink = vi.fn<ServerProgressSink>(
      () => new Promise<void>((resolve) => setTimeout(resolve, 400)),
    );
    const result = scenario.start(sink);
    await scenario.ready();
    scenario.attempt.committed();

    await expect(result).resolves.toEqual({ kind: 'started', url: PUBLIC_URL });
    expect(sink).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'ready' }));
    expect(scenario.warnings).toEqual([]);
  });

  it('never emits a journal failure for a start that committed', async () => {
    scenario = await new ServerStartupObserverScenario().open();
    scenario.operation.start('server-start');
    scenario.operation.fail('server-start', { code: 'PROGRESS_JOURNAL_LIMIT' });
    await scenario.publish();
    const result = scenario.start();
    await vi.waitFor(() => expect(scenario.reads).toBeGreaterThanOrEqual(2));
    await scenario.readyOverIpcOnly();
    scenario.attempt.committed();

    await expect(result).resolves.toEqual({ kind: 'started', url: PUBLIC_URL });
    expect(scenario.events.map(({ sequence, status }) => `${String(sequence)}:${status}`)).toEqual([
      '1:started',
      '3:ready',
    ]);
  });

  it('emits the journal failure before rejecting a failed start', async () => {
    scenario = await new ServerStartupObserverScenario().open();
    scenario.operation.start('postgres-start');
    scenario.operation.fail('postgres-start', { code: 'POSTGRES_PROCESS' });
    await scenario.publish();
    const result = scenario.start();
    await vi.waitFor(() => expect(scenario.reads).toBeGreaterThanOrEqual(2));
    scenario.attempt.booted();
    scenario.attempt.deliver('start');
    await Promise.resolve();
    scenario.attempt.failed('SERVER_HOST_FAILED', 'completed');

    await expect(result).rejects.toMatchObject({ code: 'START_FAILED', cleanup: 'completed' });
    expect(scenario.events.map(({ status }) => status)).toEqual(['started', 'failed']);
  });

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

describe('progress for a server that is already running', () => {
  it('reports reuse with a warning when progress output fails', async () => {
    const reused = await ServerStartupObserverScenario.reuse(PUBLIC_URL, () => {
      throw new Error('private output failure');
    });

    expect(reused).toEqual({ outcome: 'resolved', events: [], warnings: [OUTPUT_WARNING] });
  });

  it('reports reuse with a warning when the running server has no public URL', async () => {
    const reused = await ServerStartupObserverScenario.reuse(undefined);

    expect(reused.outcome).toBe('resolved');
    expect(reused.events).toEqual([]);
    expect(reused.warnings).toEqual([expect.stringContaining('did not report its URL')]);
  });
});
