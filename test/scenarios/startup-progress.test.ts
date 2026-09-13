import { afterEach, describe, expect, it } from 'vitest';

import { StartupProgressScenario } from '../support/progress/startup-progress-scenario.js';

describe('persisted startup progress', () => {
  let scenario = new StartupProgressScenario();
  afterEach(async () => {
    await scenario.cleanup();
    scenario = new StartupProgressScenario();
  });

  it('replays cross-process progress with latest counters and cursor deduplication', async () => {
    const result = await scenario.crossProcessReplay();
    expect(result.initial).toMatchObject({
      kind: 'events',
      events: [
        { sequence: 1, status: 'started' },
        { sequence: 4, status: 'completed' },
        { sequence: 5, status: 'started' },
        { sequence: 6, status: 'progress', stageElapsedMs: 1 },
      ],
    });
    expect(result.duplicate).toMatchObject({ kind: 'events', events: [] });
  });

  it('reports a new operation without blending retained history', async () => {
    const result = await scenario.operationChanges();
    expect(result).toEqual({
      second: 'held',
      read: { kind: 'operation-changed', operationId: '22222222222222222222222222222222' },
    });
  });

  it('never publishes ready in memory when its atomic write fails', async () => {
    const result = await scenario.readyWriteFailure();
    expect(result).toMatchObject({
      outcomes: ['rejected', 'rejected'],
      writes: 2,
      read: { kind: 'events', events: [] },
    });
    expect(JSON.stringify(result)).not.toContain('secret filesystem failure');
  });

  it('reserves the terminal transition at the exact nonterminal count limit', async () => {
    const result = await scenario.transitionLimitReservesFailure();
    expect(result.overflow).toBe('rejected');
    expect(result.kind).toBe('events');
    expect(result.count).toBe(256);
    expect(result.last).toMatchObject({
      sequence: 257,
      status: 'failed',
      code: 'PROGRESS_JOURNAL_LIMIT',
    });
  });

  it('classifies missing, malformed, oversized, linked, FIFO, public, and unavailable states', async () => {
    await expect(scenario.unsafeStates()).resolves.toEqual([
      'missing',
      'invalid',
      'invalid',
      'unavailable',
      'invalid',
      'invalid',
      'unavailable',
    ]);
  });
  it('rejects invalid cursors before IO and nonmonotonic persisted elapsed time', async () => {
    await expect(scenario.invalidCursorAndElapsedOrder()).resolves.toEqual({
      cursors: ['invalid', 'invalid', 'invalid'],
      order: 'invalid',
    });
  });

  it('releases ownership when initial journal publication fails', async () => {
    await expect(scenario.initializationFailureReleasesOwnership()).resolves.toEqual({
      failed: 'rejected',
      retry: 'held',
    });
  });

  it('accepts the exact terminal byte reserve and rejects one additional byte', async () => {
    await expect(scenario.terminalByteBoundary()).resolves.toEqual({
      accepted: 'fulfilled',
      rejected: 'rejected',
      last: expect.objectContaining({
        status: 'failed',
        code: 'PROGRESS_JOURNAL_LIMIT',
      }),
    });
  });

  it('drains an accepted write before releasing ownership and rejects later writes', async () => {
    await expect(scenario.closeDrainsAcceptedWriteBeforeRelease()).resolves.toEqual({
      late: 'rejected',
      busy: 'busy',
      replacement: 'held',
    });
  });
});
