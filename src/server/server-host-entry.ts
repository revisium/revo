import type { ServerHostProcessPort } from './server-host-process-port.js';
import {
  SERVER_HOST_PROTOCOL,
  parseServerHostParentMessage,
  type ServerHostChildMessage,
  type ServerHostFailureCode,
  type ServerHostStartMessage,
} from './server-host-protocol.js';
import type { OpenServerOwnerRequest, ServerOwnerOutcome } from './server-owner.service.js';

const SEND_MILLISECONDS = 250;

export interface ServerHostOwnerPort {
  start(signal: AbortSignal): Promise<{ readonly kind: 'ready'; readonly url: string }>;
  close(): Promise<void>;
  outcome(): Promise<ServerOwnerOutcome>;
  ownershipReleased(): Promise<void>;
}

export interface ServerHostOwnerServicePort {
  open(request: OpenServerOwnerRequest): Promise<'busy' | ServerHostOwnerPort>;
}

type HostState =
  | 'booting'
  | 'awaiting-start'
  | 'starting'
  | 'ready-awaiting-commit'
  | 'committed'
  | 'closing'
  | 'finished';

export class ServerHostEntry {
  private state: HostState = 'booting';
  private readonly controller = new AbortController();
  private readonly completion: Promise<void>;
  private resolveCompletion!: () => void;
  private owner: ServerHostOwnerPort | undefined;
  private operationId: string | undefined;
  private mode: 'detached' | 'foreground' | undefined;
  private deadline = 0;
  private deadlineTimer: NodeJS.Timeout | undefined;
  private openPending = false;
  private outcomeObserved = false;
  private failedOutcome = false;
  private ownershipReleased = false;
  private readonly pendingSends = new Set<Promise<void>>();

  constructor(
    private readonly processPort: ServerHostProcessPort,
    private readonly owners: ServerHostOwnerServicePort,
  ) {
    this.completion = new Promise((resolve) => (this.resolveCompletion = resolve));
  }

  start(): Promise<void> {
    this.processPort.onMessage((message) => this.receive(message));
    this.processPort.onDisconnect(() => this.disconnected());
    this.processPort.onSignal(() => this.signalled());
    void this.boot();
    return this.completion;
  }

  private async boot(): Promise<void> {
    try {
      await this.send(
        { protocol: SERVER_HOST_PROTOCOL, type: 'booted' },
        Date.now() + SEND_MILLISECONDS,
      );
      if (this.state === 'booting') {
        this.state = 'awaiting-start';
      }
    } catch {
      if (this.state === 'booting') {
        this.fail('SERVER_HOST_FAILED', 1);
      } else if (this.state === 'closing' && !this.openPending) {
        this.finish(1);
      }
    }
  }

  private receive(value: unknown): void {
    if (this.state === 'finished') {
      return;
    }
    const message = parseServerHostParentMessage(value);
    if (!message) {
      if (this.state !== 'committed') {
        this.fail('SERVER_HOST_INVALID_MESSAGE', 2);
      }
      return;
    }
    if (message.type === 'start') {
      this.receiveStart(message);
      return;
    }
    if (message.operationId !== this.operationId) {
      if (this.state !== 'committed') {
        this.fail('SERVER_HOST_WRONG_OPERATION', 2);
      }
      return;
    }
    if (message.type === 'cancel') {
      if (this.state !== 'committed') {
        this.fail('SERVER_HOST_CANCELLED', 1);
      }
      return;
    }
    this.commit();
  }

  private receiveStart(message: ServerHostStartMessage): void {
    if (this.state === 'committed') {
      return;
    }
    if (this.state !== 'awaiting-start') {
      this.fail('SERVER_HOST_INVALID_MESSAGE', 2);
    } else {
      this.beginStart(message);
    }
  }

  private beginStart(message: ServerHostStartMessage): void {
    this.state = 'starting';
    this.operationId = message.operationId;
    this.mode = message.mode;
    this.deadline = Date.now() + message.configuration.startupTimeout;
    this.deadlineTimer = setTimeout(
      () => this.fail('SERVER_HOST_CANCELLED', 1),
      Math.max(0, this.deadline - Date.now()),
    );
    void this.openAndStart(message);
  }

  private async openAndStart(message: ServerHostStartMessage): Promise<void> {
    this.openPending = true;
    try {
      const opened = await this.owners.open({
        configuration: message.configuration,
        environment: message.environment,
        operationId: message.operationId,
        trustedEnvironmentNames: Object.keys(message.environment),
      });
      this.openPending = false;
      if (opened === 'busy') {
        await this.sendFailure('SERVER_HOST_BUSY');
        this.finish(1);
        return;
      }
      this.owner = opened;
      this.observeOutcome(opened);
      void opened.ownershipReleased().then(() => this.released());
      if (this.state !== 'starting' || !this.processPort.connected()) {
        void opened.close().catch(() => undefined);
        return;
      }
      const ready = await opened.start(this.controller.signal);
      if (this.state !== 'starting' || !this.processPort.connected()) {
        this.beginClose();
        return;
      }
      this.state = 'ready-awaiting-commit';
      await this.send(
        {
          protocol: SERVER_HOST_PROTOCOL,
          type: 'ready',
          operationId: message.operationId,
          url: ready.url,
        },
        Math.min(this.deadline, Date.now() + SEND_MILLISECONDS),
      );
      if (this.mode === 'foreground' && this.state === 'ready-awaiting-commit') {
        this.clearDeadline();
      }
    } catch {
      this.openPending = false;
      if (this.state === 'committed') {
        return;
      } else if (this.state === 'closing' && !this.owner) {
        this.finish(1);
      } else if (this.state !== 'closing' && this.state !== 'finished') {
        this.fail('SERVER_HOST_FAILED', 1);
      }
    }
  }

  private commit(): void {
    if (this.state === 'committed') {
      this.acknowledgeCommit();
      return;
    }
    if (
      this.state !== 'ready-awaiting-commit' ||
      this.mode !== 'detached' ||
      !this.outcomeObserved ||
      this.controller.signal.aborted ||
      !this.processPort.connected() ||
      Date.now() >= this.deadline
    ) {
      this.fail('SERVER_HOST_WRONG_OPERATION', 1);
      return;
    }
    this.state = 'committed';
    this.clearDeadline();
    this.acknowledgeCommit();
  }

  private acknowledgeCommit(): void {
    const operationId = this.operationId;
    if (!operationId) {
      return;
    }
    void this.send(
      { protocol: SERVER_HOST_PROTOCOL, type: 'committed', operationId },
      Math.min(this.deadline, Date.now() + SEND_MILLISECONDS),
    ).catch(() => undefined);
  }

  private disconnected(): void {
    if (this.state === 'committed' || this.state === 'finished') {
      return;
    }
    this.beginClose();
  }

  private signalled(): void {
    if (this.state !== 'finished') {
      this.beginClose();
    }
  }

  private fail(code: ServerHostFailureCode, exitCode: 1 | 2): void {
    if (this.state === 'closing' || this.state === 'finished') {
      return;
    }
    void this.sendFailure(code);
    this.beginClose(exitCode);
  }

  private beginClose(exitCode: 1 | 2 = 1): void {
    if (this.state === 'closing' || this.state === 'finished') {
      return;
    }
    this.state = 'closing';
    this.controller.abort();
    const owner = this.owner;
    if (!owner) {
      if (!this.openPending) {
        this.finish(exitCode);
      }
      return;
    }
    void owner.close().catch(() => undefined);
  }

  private observeOutcome(owner: ServerHostOwnerPort): void {
    this.outcomeObserved = true;
    void owner.outcome().then((outcome) => this.ownerCompleted(outcome));
  }

  private ownerCompleted(outcome: ServerOwnerOutcome): void {
    if (outcome.kind === 'stopped') {
      this.finish(0);
      return;
    }
    this.failedOutcome = true;
    this.state = 'closing';
    this.controller.abort();
    void this.sendFailure('SERVER_HOST_FAILED', outcome.cleanup);
    if (outcome.cleanup === 'completed' || this.ownershipReleased) {
      this.finish(1);
    }
  }

  private released(): void {
    this.ownershipReleased = true;
    if (this.failedOutcome) {
      this.finish(1);
    }
  }

  private sendFailure(
    code: ServerHostFailureCode,
    cleanup?: 'completed' | 'retained' | 'unconfirmed',
  ): Promise<void> {
    if (!this.processPort.connected()) {
      return Promise.resolve();
    }
    return this.send(
      {
        protocol: SERVER_HOST_PROTOCOL,
        type: 'failed',
        ...(this.operationId ? { operationId: this.operationId } : {}),
        code,
        ...(cleanup ? { cleanup } : {}),
      },
      this.deadline > 0
        ? Math.min(this.deadline, Date.now() + SEND_MILLISECONDS)
        : Date.now() + SEND_MILLISECONDS,
    ).catch(() => undefined);
  }

  private send(message: ServerHostChildMessage, deadline: number): Promise<void> {
    const operation = this.processPort.send(message, deadline);
    this.pendingSends.add(operation);
    void operation.finally(() => this.pendingSends.delete(operation)).catch(() => undefined);
    return operation;
  }

  private finish(exitCode: 0 | 1 | 2): void {
    if (this.state === 'finished') {
      return;
    }
    this.state = 'finished';
    this.clearDeadline();
    void this.finishAfterSends(exitCode);
  }

  private async finishAfterSends(exitCode: 0 | 1 | 2): Promise<void> {
    await Promise.allSettled(this.pendingSends);
    let terminalExitCode = exitCode;
    try {
      await this.processPort.close(Date.now() + SEND_MILLISECONDS);
    } catch {
      terminalExitCode = 1;
    }
    this.processPort.setExitCode(terminalExitCode);
    this.resolveCompletion();
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
    }
    this.deadlineTimer = undefined;
  }
}
