import { afterEach, describe, expect, it } from 'vitest';

import { ControlScenario } from '../support/process/control-scenario.js';

describe('authenticated private control transport', () => {
  let scenario = new ControlScenario();
  afterEach(async () => {
    await scenario.cleanup();
    scenario = new ControlScenario();
  });

  it('probes exact host facts and coalesces concurrent stop requests', async () => {
    await expect(scenario.probesAndStopsOnce()).resolves.toEqual({
      probe: { kind: 'confirmed' },
      accepted: [{ kind: 'accepted' }],
      stops: 1,
      stopResult: { kind: 'completed' },
    });
  });
  it('holds the stop responder through cleanup and rejects new admission', async () => {
    await expect(scenario.waitsForCleanupAndRejectsAdmission()).resolves.toEqual({
      beforeCleanup: false,
      admission: 'rejected',
      completion: { kind: 'completed' },
    });
  });
  it('rearms only after proven retention and treats unconfirmed cleanup as terminal', async () => {
    await expect(scenario.rearmsOnlyWhenRetentionIsProven()).resolves.toEqual({
      first: {
        kind: 'failed',
        ownership: 'retained',
        error: { code: 'CONTROL_STOP_FAILED', message: 'Control stop callback failed' },
      },
      second: { kind: 'completed' },
      failed: {
        kind: 'failed',
        ownership: 'unconfirmed',
        error: { code: 'CONTROL_STOP_FAILED', message: 'Control stop callback failed' },
      },
      retry: 'rejected',
    });
  });
  it('parses accepted and completed frames delivered in one chunk', async () => {
    await expect(scenario.acceptsCoalescedStopFrames()).resolves.toEqual({
      legacy: { kind: 'accepted' },
      strict: { kind: 'completed' },
    });
  });
  it('does not infer success when the completion reply is lost', async () => {
    await expect(scenario.doesNotInferCompletionFromReplyLoss()).resolves.toBe('unconfirmed');
  });
  it('observes final reply failure after successful cleanup without rearming', async () => {
    await expect(scenario.observesFailedFinalReplyAfterCleanup()).resolves.toEqual({
      cleanup: { kind: 'completed' },
      delivery: { kind: 'failed' },
      cleaned: true,
    });
  });
  it('rejects wrong tokens and instance identities', async () => {
    const results = await scenario.rejectsAuthentication();
    expect(results.map(({ status }) => status)).toEqual(['rejected', 'rejected']);
  });
  it('reports callback failure safely and permits callback-owned close', async () => {
    await expect(scenario.observesCallbackFailureAndSelfClose()).resolves.toEqual({
      failedResult: {
        kind: 'failed',
        error: { code: 'CONTROL_STOP_FAILED', message: 'Control stop callback failed' },
      },
      selfClose: { kind: 'completed' },
    });
  });
  it('closes without waiting for idle partial clients', async () => {
    await expect(scenario.closeWithIdlePartialConnection()).resolves.toEqual({
      kind: 'not-requested',
    });
  });
  it('fails closed on malformed, oversized, partial and deadline-bound frames', async () => {
    await expect(scenario.rejectsBadFrames()).resolves.toEqual(['closed', 'closed', 'closed']);
    const responses = await scenario.rejectsMalformedServerResponses();
    expect(responses.map(({ status }) => status)).toEqual(['rejected', 'rejected', 'rejected']);
  });
  it('rejects NUL and overlong UTF-8 endpoints before listening', async () => {
    const results = await scenario.validatesPathBeforeListening();
    expect(results.map(({ status }) => status)).toEqual(['rejected', 'rejected']);
  });
  it('binds the native byte boundary in a newly private directory', async () => {
    const result = await scenario.acceptsNativePathBoundaryAndPrivateDirectory();
    expect(result).toEqual({ bytes: process.platform === 'darwin' ? 103 : 107, mode: 0o700 });
    await expect(scenario.rejectsPublicRuntimeDirectory()).rejects.toMatchObject({
      code: 'CONTROL_TRANSPORT_ERROR',
    });
  });
  it('runs an accepted stop after disconnect and resolves close-before-stop', async () => {
    await expect(scenario.disconnectsAfterAcceptedStop()).resolves.toBe(1);
    await expect(scenario.closesBeforeStop()).resolves.toEqual({ kind: 'not-requested' });
  });
  it('does not let a repeated old close remove a successor socket', async () => {
    await expect(scenario.preservesSuccessorAtSamePath()).resolves.toBe('successor');
  });
});
