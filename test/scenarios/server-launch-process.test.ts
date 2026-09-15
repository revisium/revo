import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SERVER_HOST_PROTOCOL,
  type ServerHostParentMessage,
} from '../../src/server/server-host-protocol.js';
import {
  launchWithMissingCapability,
  launchWithStopInteraction,
  ServerLaunchProcessScenario,
  type StopInteractionCase,
} from '../support/server/server-launch-process-scenario.js';

describe('server launch process adapter', () => {
  it('composes the exact managed process request for the underlying managed process service', async () => {
    const subject = await ServerLaunchProcessScenario.create();
    await subject.start();
    await subject.booted();

    expect(subject.managedProcessRequests()).toEqual([subject.expectedManagedProcessRequest()]);
  });

  it('stops and reaps the managed process when adapter construction is missing a capability', async () => {
    const outcome = await launchWithMissingCapability();

    expect(outcome.error).toMatchObject({ code: 'revo.process.invalid' });
    expect(outcome.stopRequests).toEqual([{ graceMs: 25, killWaitMs: 500 }]);
    expect(outcome.completion).toEqual({ exitCode: 0, signal: null });
  });

  it.each<StopInteractionCase>([
    'stop-rejects-completion-pending',
    'stop-resolves-completion-rejects',
  ])('settles promptly with the original capability error when %s', async (interaction) => {
    const error = await launchWithStopInteraction(interaction);

    expect(error).toMatchObject({ code: 'revo.process.invalid' });
  });

  it('starts a detached IPC child with explicit binding and observes a completed send', async () => {
    const subject = await ServerLaunchProcessScenario.create();
    const process = await subject.start();
    await subject.booted();

    const operationId = 'accepted-operation';
    const message: ServerHostParentMessage = {
      protocol: SERVER_HOST_PROTOCOL,
      type: 'commit',
      operationId,
    };
    const observed = subject.observed(operationId);
    await subject.send(process, message);

    await subject.waitForEvent(message);
    expect(await observed).toEqual({
      protocol: SERVER_HOST_PROTOCOL,
      type: 'committed',
      operationId,
    });
  });

  it('removes an IPC subscription without affecting later sends', async () => {
    const subject = await ServerLaunchProcessScenario.create();
    const process = await subject.start();
    await subject.booted();
    const received: unknown[] = [];
    const unsubscribe = process.subscribe((message) => received.push(message));

    const first: ServerHostParentMessage = {
      protocol: SERVER_HOST_PROTOCOL,
      type: 'commit',
      operationId: 'first-operation',
    };
    const firstObserved = subject.observed('first-operation');
    await subject.send(process, first);
    await subject.waitForEvent(first);
    await firstObserved;
    unsubscribe();
    const second: ServerHostParentMessage = {
      protocol: SERVER_HOST_PROTOCOL,
      type: 'commit',
      operationId: 'second-operation',
    };
    const secondObserved = subject.observed('second-operation');
    await subject.send(process, second);
    await subject.waitForEvent(second);
    await secondObserved;

    expect(received).toEqual([
      { protocol: SERVER_HOST_PROTOCOL, type: 'committed', operationId: 'first-operation' },
    ]);
  });

  it('rejects sends safely after the real child disconnects and still reaps it', async () => {
    const subject = await ServerLaunchProcessScenario.create();
    const process = await subject.start();
    await subject.booted();
    const disconnect: ServerHostParentMessage = {
      protocol: SERVER_HOST_PROTOCOL,
      type: 'cancel',
      operationId: 'shutdown-operation',
    };
    await subject.send(process, disconnect);

    expect(await subject.completion(process)).toEqual({ exitCode: 0, signal: null });
    await expect(
      subject.send(process, {
        protocol: SERVER_HOST_PROTOCOL,
        type: 'commit',
        operationId: 'late-operation',
      }),
    ).rejects.toMatchObject({ code: 'revo.process.invalid' });
  });

  it('routes cancellation through owned bounded termination and completion', async () => {
    const subject = await ServerLaunchProcessScenario.create();
    const process = await subject.start();
    await subject.booted();

    subject.abort();

    expect(await subject.completion(process)).toEqual({ exitCode: null, signal: 'SIGTERM' });
  });

  it('rejects a spawn failure without returning an owned process port', async () => {
    const subject = await ServerLaunchProcessScenario.create();

    await expect(
      subject.start({ executable: join('/missing', 'revo-node') }),
    ).rejects.toMatchObject({ code: 'revo.process.spawn' });
  });
});
