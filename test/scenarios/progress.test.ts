import { describe, expect, it } from 'vitest';

import { ProgressScenario } from '../support/progress/progress-scenario.js';

describe('progress events and rendering', () => {
  it('retains fast phase transitions between cursor reads without duplicates', () => {
    const result = new ProgressScenario().transitionsAndCursors();
    expect(result.first.map(({ sequence, status }) => [sequence, status])).toEqual([
      [1, 'started'],
      [2, 'progress'],
    ]);
    expect(result.after.map(({ sequence, status }) => [sequence, status])).toEqual([
      [3, 'completed'],
    ]);
    expect(result.duplicate).toEqual([]);
  });
  it('keeps one latest progress record ordered after all retained transitions', () => {
    const events = new ProgressScenario().singleCurrentProgressRemainsOrdered();
    expect(events.map(({ sequence }) => sequence)).toEqual([1, 3, 5, 6]);
    expect(events.filter(({ status }) => status === 'progress')).toEqual([
      expect.objectContaining({ sequence: 6, phase: 'runtime-extract' }),
    ]);
  });
  it('keeps snapshots immutable and elapsed time monotonic across clock rollback', () => {
    const result = new ProgressScenario().clockRollbackAndImmutableSnapshots();
    expect(result.frozen).toBe(true);
    expect(result.completed).toMatchObject({ elapsedMs: 50, stageElapsedMs: 60 });
    expect(result.snapshot[1]?.counters).toEqual({ pnpmResolved: 2 });
    expect(Object.isFrozen(result.snapshot[1]?.counters)).toBe(true);
  });
  it('rejects invalid progress without poisoning phase state', () => {
    const result = new ProgressScenario().invalidProgressLeavesOperationUsable();
    expect(result.rejected).toBe(result.invalid);
    expect(result.events).toHaveLength(3);
    expect(result.progress).toMatchObject({ stageElapsedMs: 10 });
    expect(result.completed).toMatchObject({ stageElapsedMs: 20 });
  });
  it('emits exactly one terminal failure and ignores all later declarations', () => {
    const result = new ProgressScenario().terminalBehavior();
    expect(result.failed).toMatchObject({ status: 'failed', code: 'API_FAILED' });
    expect(result.lateReady).toBeUndefined();
    expect(result.lateProgress).toBeUndefined();
    expect(result.events).toHaveLength(1);
  });
  it('emits fresh reused readiness without fabricated phases', () => {
    expect(new ProgressScenario().reusedReady()).toMatchObject({
      sequence: 1,
      phase: 'server-start',
      status: 'ready',
      reused: true,
    });
  });
  it('safely rejects malformed envelopes and counters', () => {
    expect(new ProgressScenario().malformedEvents()).toEqual(Array.from({ length: 12 }));
    expect(new ProgressScenario().extensionPhase()).toMatchObject({ phase: 'plugin-bootstrap' });
  });
  it('writes only valid newline-delimited envelopes to JSONL stdout', () => {
    const scenario = new ProgressScenario();
    const output = scenario.render('jsonl', false);
    expect(output.stderr).toBe('');
    expect(output.stdout.endsWith('\n')).toBe(true);
    expect(scenario.parsedJsonl(output.stdout).every(Boolean)).toBe(true);
  });
  it('renders unknown totals without imaginary percentages or non-TTY redraws', () => {
    const output = new ProgressScenario().render('human', false);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('12 bytes');
    expect(output.stderr).toContain('0ms');
    expect(output.stderr).not.toContain('%');
    expect(output.stderr).not.toContain('\r');
  });
  it('closes a TTY line before rendering terminal failure', () => {
    const output = new ProgressScenario().render('human', true);
    expect(output.stderr).toContain('\rruntime-download');
    expect(output.stderr).toMatch(/\nruntime-download: failed/);
  });
  it('pads a shorter TTY redraw so the previous line leaves no residue', () => {
    const output = new ProgressScenario().ttyShortensWithoutResidue();
    expect(output).toMatch(/\rdependencies-install: progress 0ms +\n$/);
  });
});
