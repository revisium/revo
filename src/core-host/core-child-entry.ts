import {
  CORE_HOST_PROTOCOL,
  parseCoreHostMessage,
  type CoreHostMessage,
} from './core-child-protocol.js';
import type { CoreChildTransport } from './core-child-runner.js';

export interface CoreChildProcessPort {
  connected(): boolean;
  disconnect(): void;
  onDisconnect(listener: () => void): void;
  onMessage(listener: (message: unknown) => void): void;
  send(message: CoreHostMessage): Promise<void>;
  setExitCode(exitCode: 0 | 1 | 2): void;
}

export interface CoreChildRunnerLike {
  disconnected(): Promise<void>;
  receive(message: unknown): void;
}

export type CoreChildRunnerLoader = () => Promise<
  new (transport: CoreChildTransport) => CoreChildRunnerLike
>;

export class CoreChildEntry {
  private readonly pending: unknown[] = [];
  private runner: CoreChildRunnerLike | undefined;
  private loadOperation: Promise<void> | undefined;
  private disconnected = false;
  private finished = false;

  constructor(
    private readonly processPort: CoreChildProcessPort,
    private readonly loadRunner: CoreChildRunnerLoader,
  ) {}

  start(): void {
    this.processPort.onMessage((message) => this.receive(message));
    this.processPort.onDisconnect(() => this.handleDisconnect());
  }

  private receive(value: unknown): void {
    if (this.disconnected || this.finished) {
      return;
    }
    const message = parseCoreHostMessage(value);
    if (message?.type === 'hello') {
      this.loadOperation ??= this.boot();
      return;
    }
    if (!this.runner) {
      this.pending.push(value);
      return;
    }
    this.runner.receive(value);
  }

  private async boot(): Promise<void> {
    try {
      const Runner = await this.loadRunner();
      if (this.disconnected || this.finished) {
        this.finish(0);
        return;
      }
      const runner = new Runner({
        send: (message) => this.processPort.send(message),
        finish: (exitCode) => this.finish(exitCode),
      });
      await this.processPort.send({ protocol: CORE_HOST_PROTOCOL, type: 'booted' });
      if (this.disconnected || this.finished) {
        await runner.disconnected();
        return;
      }
      this.runner = runner;
      this.pending.splice(0).forEach((message) => runner.receive(message));
    } catch {
      if (this.disconnected) {
        this.finish(0);
        return;
      }
      await this.fail();
    }
  }

  private handleDisconnect(): void {
    this.disconnected = true;
    if (this.runner) {
      void this.runner.disconnected().catch(() => this.finish(1));
      return;
    }
    if (!this.loadOperation) {
      this.finish(0);
    }
  }

  private async fail(): Promise<void> {
    if (this.processPort.connected()) {
      await this.processPort
        .send({ protocol: CORE_HOST_PROTOCOL, type: 'failed', code: 'CORE_HOST_FAILED' })
        .catch(() => undefined);
    }
    this.finish(1);
  }

  private finish(exitCode: 0 | 1 | 2): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.processPort.setExitCode(exitCode);
    if (this.processPort.connected()) {
      this.processPort.disconnect();
    }
  }
}
