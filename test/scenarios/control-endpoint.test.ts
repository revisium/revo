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
      accepted: [{ kind: 'accepted' }, { kind: 'accepted' }],
      stops: 1,
      stopResult: { kind: 'completed' },
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
