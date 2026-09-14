import { afterEach, describe, expect, it, vi } from 'vitest';

import { SERVER_HOST_PROTOCOL } from '../../src/server/server-host-protocol.js';
import { ServerHostScenario } from '../support/server/server-host-scenario.js';

describe('Private server host', () => {
  afterEach(() => vi.useRealTimers());

  it('makes commit the synchronous ownership fence before a later disconnect', async () => {
    const scenario = await readyScenario();
    scenario.commit();
    scenario.disconnect();
    await scenario.process.ackAttempted.promise;

    expect(scenario.messages('committed')).toHaveLength(1);
    expect(scenario.owner.closeCalls).toBe(0);
  });

  it('does not revoke committed ownership when the earlier ready callback later rejects', async () => {
    const scenario = await startingScenario();
    scenario.process.holdReady = true;
    scenario.becomeReady();
    await scenario.process.readyAttempted.promise;

    scenario.commit();
    scenario.process.rejectReady();
    expect(await scenario.process.readySettled.promise).toBe('rejected');

    expect(scenario.owner.closeCalls).toBe(0);
    expect(scenario.process.exitCode).toBeUndefined();
  });

  it('bounds ready delivery to 250ms within the original startup deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const scenario = await startingScenario();
    scenario.process.holdReady = true;
    const readyAt = Date.now();
    scenario.becomeReady();
    await scenario.process.readyAttempted.promise;

    expect(scenario.process.readyDeadlines).toEqual([readyAt + 250]);
  });

  it('cleans a subsequently obtained owner without late start when disconnect wins pending open', async () => {
    const scenario = new ServerHostScenario();
    scenario.start();
    await scenario.process.bootedDelivered.promise;
    scenario.sendStart();
    await scenario.openEntered.promise;
    scenario.disconnect();
    scenario.allowOwner();
    await scenario.owner.closeCompleted.promise;

    expect(scenario.owner.startCalls).toBe(0);
    expect(scenario.messages('ready')).toHaveLength(0);
  });

  it('cleans a pending start and never sends late readiness when disconnect wins', async () => {
    const scenario = await startingScenario();
    scenario.disconnect();
    scenario.becomeReady();
    await scenario.owner.closeCompleted.promise;

    expect(scenario.messages('ready')).toHaveLength(0);
    expect(scenario.messages('committed')).toHaveLength(0);
  });

  it('lets disconnect synchronously win over a later commit', async () => {
    const scenario = await readyScenario();
    scenario.disconnect();
    scenario.commit();
    await scenario.owner.closeCompleted.promise;

    expect(scenario.messages('committed')).toHaveLength(0);
    expect(scenario.owner.closeCalls).toBe(1);
  });

  it('bounds an undelivered acknowledgement at 250ms without revoking ownership', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const scenario = await readyScenario();
    scenario.process.holdCommitted = true;
    const committedAt = Date.now();
    scenario.commit();
    await scenario.process.ackAttempted.promise;
    expect(scenario.process.committedDeadlines).toEqual([committedAt + 250]);
    await vi.advanceTimersByTimeAsync(250);
    expect(await scenario.process.ackSettled.promise).toBe('deadline');

    expect(scenario.owner.closeCalls).toBe(0);
    expect(scenario.process.exitCode).toBeUndefined();
  });

  it('caps acknowledgement by the remaining original startup deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const scenario = await readyScenario('detached', 40);
    scenario.process.holdCommitted = true;
    const committedAt = Date.now();
    scenario.commit();
    await scenario.process.ackAttempted.promise;
    expect(scenario.process.committedDeadlines).toEqual([committedAt + 40]);
    await vi.advanceTimersByTimeAsync(40);
    expect(await scenario.process.ackSettled.promise).toBe('deadline');
    expect(scenario.owner.closeCalls).toBe(0);
    expect(scenario.process.exitCode).toBeUndefined();
  });

  it('acknowledges duplicate commit but ignores a wrong postcommit operation', async () => {
    const scenario = await readyScenario();
    scenario.commit();
    await scenario.process.ackDelivered.promise;
    scenario.commit();
    scenario.commit('ffffffffffffffffffffffffffffffff');

    expect(scenario.messages('committed')).toHaveLength(2);
    expect(scenario.owner.closeCalls).toBe(0);
  });

  it('bounds malformed input before ownership and prevents a late start', async () => {
    const scenario = new ServerHostScenario();
    scenario.start();
    await scenario.process.bootedDelivered.promise;
    scenario.malformed();
    scenario.sendStart();
    expect(await scenario.process.settled.promise).toBe(2);

    expect(scenario.owner.startCalls).toBe(0);
    expect(scenario.messages('failed')).toHaveLength(1);
  });

  it('cleans an opened owner for a wrong precommit operation', async () => {
    const scenario = await readyScenario();
    scenario.cancel('ffffffffffffffffffffffffffffffff');
    await scenario.owner.closeCompleted.promise;

    expect(scenario.messages('failed')).toHaveLength(1);
    expect(scenario.owner.closeCalls).toBe(1);
  });

  it('keeps postcommit malformed input and cancel from tearing down the owner', async () => {
    const scenario = await readyScenario();
    scenario.commit();
    await scenario.process.ackDelivered.promise;
    scenario.malformed();
    scenario.cancel();

    expect(scenario.owner.closeCalls).toBe(0);
  });

  it('keeps foreground mode parent-bound without a commit fence', async () => {
    const scenario = await readyScenario('foreground');
    scenario.commit();
    scenario.disconnect();
    await scenario.owner.closeCompleted.promise;

    expect(scenario.messages('committed')).toHaveLength(0);
    expect(scenario.owner.closeCalls).toBe(1);
  });

  it('keeps a ready foreground owner alive after the original startup deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const scenario = await readyScenario('foreground', 40);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(scenario.owner.closeCalls).toBe(0);
    expect(scenario.process.exitCode).toBeUndefined();
    scenario.disconnect();
    await scenario.owner.closeCompleted.promise;
  });

  it('routes repeated postcommit signals through one owned graceful close', async () => {
    const scenario = await readyScenario();
    scenario.commit();
    scenario.process.signal();
    scenario.process.signal();
    await scenario.process.settled.promise;

    expect(scenario.owner.closeCalls).toBe(1);
  });

  it('replays an early signal without opening startup admission', async () => {
    const scenario = new ServerHostScenario();
    scenario.process.signal();
    scenario.start();
    expect(await scenario.process.settled.promise).toBe(1);

    expect(scenario.owner.startCalls).toBe(0);
  });

  it('leaves retained cleanup and its retryable owner alive', async () => {
    const scenario = await readyScenario();
    scenario.owner.complete({
      kind: 'failed',
      code: 'revo.server-owner.stop',
      cleanup: 'retained',
    });
    await failedMessage(scenario);

    expect(scenario.owner.closeCalls).toBe(0);
    expect(scenario.process.exitCode).toBeUndefined();
    scenario.owner.releaseOwnership();
    expect(await scenario.process.settled.promise).toBe(1);
    expect(scenario.owner.closeCalls).toBe(0);
  });

  it('waits for a late failed outcome after ownership was independently released', async () => {
    const scenario = await readyScenario();
    scenario.owner.releaseOwnership();
    expect(scenario.process.exitCode).toBeUndefined();
    scenario.owner.complete({
      kind: 'failed',
      code: 'revo.server-owner.stop',
      cleanup: 'retained',
    });

    expect(await scenario.process.settled.promise).toBe(1);
    expect(scenario.owner.closeCalls).toBe(0);
  });

  it('observes owner exit on both sides of the commit fence', async () => {
    const before = await readyScenario();
    before.owner.complete({ kind: 'failed', code: 'revo.server-owner.core', cleanup: 'completed' });
    expect(await before.process.settled.promise).toBe(1);
    expect(before.messages('committed')).toHaveLength(0);

    const after = await readyScenario();
    after.commit();
    await after.process.ackAttempted.promise;
    after.owner.complete({ kind: 'stopped' });
    expect(await after.process.settled.promise).toBe(0);
    expect(after.owner.closeCalls).toBe(0);
  });

  it('reports an existing owner for later status reuse without starting another', async () => {
    const scenario = new ServerHostScenario();
    scenario.start();
    await scenario.process.bootedDelivered.promise;
    scenario.sendStart();
    await scenario.openEntered.promise;
    scenario.reportBusy();
    await failedMessage(scenario);

    expect(scenario.messages('failed')).toContainEqual({
      protocol: SERVER_HOST_PROTOCOL,
      type: 'failed',
      operationId: '0123456789abcdef0123456789abcdef',
      code: 'SERVER_HOST_BUSY',
    });
    expect(scenario.owner.startCalls).toBe(0);
  });
});

async function startingScenario() {
  const scenario = new ServerHostScenario();
  scenario.start();
  await scenario.process.bootedDelivered.promise;
  scenario.sendStart();
  await scenario.openEntered.promise;
  scenario.allowOwner();
  await scenario.owner.startEntered.promise;
  return scenario;
}

async function readyScenario(mode: 'detached' | 'foreground' = 'detached', startupTimeout = 5_000) {
  const scenario = new ServerHostScenario();
  scenario.start();
  await scenario.process.bootedDelivered.promise;
  scenario.sendStart(mode, startupTimeout);
  await scenario.openEntered.promise;
  scenario.allowOwner();
  await scenario.owner.startEntered.promise;
  scenario.becomeReady();
  await scenario.process.readyDelivered.promise;
  return scenario;
}

async function failedMessage(scenario: ServerHostScenario) {
  await boundedUntil(() => scenario.messages('failed').length > 0);
}

async function boundedUntil(predicate: () => boolean, deadline = Date.now() + 300): Promise<void> {
  if (predicate()) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error('Expected server host observation was not reached');
  }
  await new Promise((resolve) => setTimeout(resolve, 1));
  await boundedUntil(predicate, deadline);
}
