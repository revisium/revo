import type { RevoCoreLifecycleEvent } from '@revisium/revo-core/runtime';

import { CORE_HOST_PROTOCOL, type CoreHostStageMessage } from './core-child-protocol.js';

export type CoreStageSender = (message: CoreHostStageMessage) => Promise<void>;

export class CoreStageBridge {
  private queue = Promise.resolve();
  private firstFailure: Error | undefined;

  constructor(private readonly send: CoreStageSender) {}

  onStage = (event: RevoCoreLifecycleEvent): void => {
    const message: CoreHostStageMessage =
      event.status === 'failed'
        ? {
            protocol: CORE_HOST_PROTOCOL,
            type: 'stage',
            stage: event.stage,
            status: 'failed',
            code: 'CORE_STAGE_FAILED',
          }
        : {
            protocol: CORE_HOST_PROTOCOL,
            type: 'stage',
            stage: event.stage,
            status: event.status,
          };
    this.queue = this.queue.then(async () => {
      if (this.firstFailure) {
        return;
      }
      try {
        await this.send(message);
      } catch {
        this.firstFailure ??= new Error('Core stage bridge could not send an event');
        this.firstFailure.name = 'CoreStageBridgeError';
      }
    });
  };

  async drain(): Promise<void> {
    await this.queue;
    if (this.firstFailure) {
      throw this.firstFailure;
    }
  }
}
