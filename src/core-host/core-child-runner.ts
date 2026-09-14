import type { RevoCoreRuntime } from '@revisium/revo-core/runtime';

import {
  CORE_HOST_PROTOCOL,
  parseCoreHostMessage,
  type CoreHostFailedMessage,
  type CoreHostMessage,
  type CoreHostStartMessage,
} from './core-child-protocol.js';
import { CoreRuntimeService, CoreRuntimeStoppedError } from './core-runtime.service.js';
import { CoreStageBridge } from './core-stage-bridge.js';

export interface CoreChildTransport {
  send(message: CoreHostMessage): Promise<void>;
  finish(exitCode: 0 | 1 | 2): void;
}

export class CoreChildRunner {
  private readonly abortController = new AbortController();
  private runtime: RevoCoreRuntime | undefined;
  private operation: Promise<void> | undefined;
  private closeOperation: Promise<void> | undefined;
  private terminalOperation: Promise<void> | undefined;
  private startupFailed = false;
  private stopping = false;

  constructor(
    private readonly transport: CoreChildTransport,
    private readonly runtimes = new CoreRuntimeService(),
  ) {}

  receive(value: unknown): void {
    const message = parseCoreHostMessage(value);
    if (!message || (message.type !== 'start' && message.type !== 'shutdown')) {
      void this.terminate(2);
      return;
    }
    if (message.type === 'shutdown') {
      void this.terminate();
      return;
    }
    if (this.operation || this.stopping) {
      void this.terminate(2);
      return;
    }
    this.operation = this.start(message);
    void this.operation.then(() => {
      if (this.startupFailed && !this.terminalOperation) {
        void this.terminate(1);
      }
    });
  }

  async disconnected(): Promise<void> {
    await this.terminate();
  }

  private async start(message: CoreHostStartMessage): Promise<void> {
    const bridge = new CoreStageBridge((event) => this.transport.send(event));
    try {
      const started = await this.runtimes.start(
        message,
        this.abortController.signal,
        bridge.onStage,
      );
      this.runtime = started.runtime;
      await bridge.drain();
      if (this.stopping) {
        await this.closeRuntime();
        return;
      }
      await this.transport.send({
        protocol: CORE_HOST_PROTOCOL,
        type: 'listening',
        ...started.listening,
      });
    } catch (error) {
      try {
        await bridge.drain();
      } catch {
        // The safe failure below is the only externally observable error.
      }
      if (error instanceof CoreRuntimeStoppedError || this.stopping) {
        if (!(error instanceof CoreRuntimeStoppedError)) {
          this.startupFailed = true;
        }
        return;
      }
      this.startupFailed = true;
    }
  }

  private terminate(requestedExitCode?: 1 | 2): Promise<void> {
    this.terminalOperation ??= this.finish(requestedExitCode);
    return this.terminalOperation;
  }

  private async finish(requestedExitCode?: 1 | 2): Promise<void> {
    this.stopping = true;
    this.abortController.abort();
    await this.operation?.catch(() => {
      this.startupFailed = true;
    });
    let cleanupFailed = false;
    try {
      await this.closeRuntime();
    } catch {
      cleanupFailed = true;
    }
    const exitCode = requestedExitCode ?? (this.startupFailed || cleanupFailed ? 1 : 0);
    if (exitCode !== 0) {
      await this.sendFailure('CORE_HOST_FAILED');
    }
    this.transport.finish(exitCode);
  }

  private closeRuntime(): Promise<void> {
    this.closeOperation ??= this.runtime?.close() ?? Promise.resolve();
    return this.closeOperation;
  }

  private async sendFailure(code: CoreHostFailedMessage['code']): Promise<void> {
    try {
      await this.transport.send({ protocol: CORE_HOST_PROTOCOL, type: 'failed', code });
    } catch {
      // Transport failure does not expose the underlying error.
    }
  }
}
