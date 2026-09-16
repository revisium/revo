import type { ProcessCompletion } from '../processes/managed-process.types.js';
import {
  SERVER_HOST_PROTOCOL,
  parseServerHostParentMessage,
  type ServerHostChildMessage,
  type ServerHostParentMessage,
  type ServerHostStartMessage,
} from './server-host-protocol.js';

export interface ServerLaunchProcessPort {
  readonly completion: Promise<ProcessCompletion>;
  abandonUncertain(): Promise<void>;
  detachCommitted(): Promise<void>;
  send(message: ServerHostParentMessage): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (message: unknown) => void): () => void;
}

export interface ServerLaunchOptions {
  readonly deadline: number;
  readonly signal: AbortSignal;
}

export interface StartedServer {
  readonly kind: 'started';
  readonly url: string;
}

type AttemptState =
  | 'awaiting-boot'
  | 'sending-start'
  | 'awaiting-ready'
  | 'sending-commit'
  | 'awaiting-ack'
  | 'terminal';

type Cleanup = 'completed' | 'retained' | 'unconfirmed';
type StartErrorCode =
  | 'START_BUSY'
  | 'START_CANCELLED'
  | 'START_FAILED'
  | 'START_OUTCOME_UNKNOWN'
  | 'REVO_ACTIVATION_STATE_INCOMPATIBLE';

class ServerLaunchError extends Error {
  readonly code: StartErrorCode;
  declare readonly cleanup?: Cleanup;

  constructor(code: StartErrorCode, cleanup?: Cleanup) {
    super('Server launch attempt failed.');
    this.name = 'ServerLaunchError';
    this.code = code;
    if (cleanup !== undefined) {
      this.cleanup = cleanup;
    }
  }
}

export class ServerLaunchAttempt {
  constructor(private readonly process: ServerLaunchProcessPort) {}

  start(message: ServerHostStartMessage, options: ServerLaunchOptions): Promise<StartedServer> {
    const parsed = parseServerHostParentMessage(message);
    if (parsed?.type !== 'start' || !Number.isFinite(options.deadline)) {
      return this.stopBeforeFence(new ServerLaunchError('START_FAILED'));
    }
    return new AttemptOperation(this.process, parsed, options).start();
  }

  private async stopBeforeFence(error: ServerLaunchError): Promise<never> {
    try {
      await this.process.stop();
    } catch {
      throw new ServerLaunchError(error.code, 'retained');
    }
    await this.process.completion;
    throw error;
  }
}

class AttemptOperation {
  private state: AttemptState = 'awaiting-boot';
  private readonly result: Promise<StartedServer>;
  private resolveResult!: (result: StartedServer) => void;
  private rejectResult!: (error: ServerLaunchError) => void;
  private timer!: NodeJS.Timeout;
  private unsubscribe!: () => void;

  constructor(
    private readonly process: ServerLaunchProcessPort,
    private readonly startMessage: ServerHostStartMessage,
    private readonly options: ServerLaunchOptions,
  ) {
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  start(): Promise<StartedServer> {
    this.unsubscribe = this.process.subscribe((message) => this.receive(message));
    this.options.signal.addEventListener('abort', this.aborted, { once: true });
    this.timer = setTimeout(this.expired, Math.max(0, this.options.deadline - Date.now()));
    void this.process.completion.then(
      () => this.processExited(),
      () => this.processExited(),
    );
    if (this.options.signal.aborted) {
      this.aborted();
    }
    return this.result;
  }

  private readonly aborted = (): void => {
    if (this.state === 'awaiting-boot' || this.state === 'sending-start') {
      this.failBeforeFence(new ServerLaunchError('START_CANCELLED'));
    } else {
      this.failAfterFence();
    }
  };

  private readonly expired = (): void => {
    this.failForState();
  };

  private receive(value: unknown): void {
    if (this.state === 'terminal') {
      return;
    }
    const message = parseChildMessage(value);
    if (!message) {
      this.failForState();
      return;
    }
    if (this.state === 'awaiting-boot' && message.type === 'booted') {
      this.sendStart();
      return;
    }
    if (this.state === 'awaiting-ready' && message.type === 'ready') {
      if (
        message.operationId === this.startMessage.operationId &&
        message.url === this.startMessage.configuration.publicUrl
      ) {
        this.sendCommit();
      } else {
        this.failAfterFence();
      }
      return;
    }
    if (this.state === 'awaiting-ready' && message.type === 'failed') {
      this.hostFailed(message);
      return;
    }
    if (
      this.state === 'awaiting-ack' &&
      message.type === 'committed' &&
      message.operationId === this.startMessage.operationId
    ) {
      this.committed();
      return;
    }
    this.failForState();
  }

  private sendStart(): void {
    this.state = 'sending-start';
    void this.process.send(this.startMessage).then(
      () => {
        if (this.state === 'sending-start') {
          this.state = 'awaiting-ready';
        }
      },
      () => this.failBeforeFence(new ServerLaunchError('START_FAILED')),
    );
  }

  private sendCommit(): void {
    this.state = 'sending-commit';
    const commit = {
      protocol: SERVER_HOST_PROTOCOL,
      type: 'commit',
      operationId: this.startMessage.operationId,
    } as const;
    void this.process.send(commit).then(
      () => {
        if (this.state === 'sending-commit') {
          this.state = 'awaiting-ack';
        }
      },
      () => this.failAfterFence(),
    );
  }

  private committed(): void {
    if (!this.claimTerminal()) {
      return;
    }
    void this.process.detachCommitted().then(
      () => this.resolveResult({ kind: 'started', url: this.startMessage.configuration.publicUrl }),
      () => this.abandonAfterDetachFailure(),
    );
  }

  private hostFailed(message: Extract<ServerHostChildMessage, { type: 'failed' }>): void {
    if (message.operationId !== this.startMessage.operationId) {
      this.failAfterFence();
      return;
    }
    if (message.code === 'SERVER_HOST_BUSY' && message.cleanup === undefined) {
      this.failAfterFence(new ServerLaunchError('START_BUSY'));
      return;
    }
    if (message.code === 'REVO_ACTIVATION_STATE_INCOMPATIBLE') {
      this.failAfterFence(new ServerLaunchError(message.code, message.cleanup));
      return;
    }
    if (message.code === 'SERVER_HOST_FAILED' && message.cleanup === 'completed') {
      this.failAfterFence(new ServerLaunchError('START_FAILED', 'completed'));
      return;
    }
    const cleanup = message.code === 'SERVER_HOST_FAILED' ? message.cleanup : undefined;
    this.failAfterFence(new ServerLaunchError('START_OUTCOME_UNKNOWN', cleanup));
  }

  private processExited(): void {
    this.failForState();
  }

  private failForState(): void {
    if (this.state === 'awaiting-boot' || this.state === 'sending-start') {
      this.failBeforeFence(new ServerLaunchError('START_FAILED'));
    } else {
      this.failAfterFence();
    }
  }

  private failBeforeFence(error: ServerLaunchError): void {
    if (!this.claimTerminal()) {
      return;
    }
    void this.finishOwnedCleanup(error);
  }

  private failAfterFence(
    error: ServerLaunchError = new ServerLaunchError('START_OUTCOME_UNKNOWN'),
  ): void {
    if (!this.claimTerminal()) {
      return;
    }
    void this.process.abandonUncertain().then(
      () => this.rejectResult(error),
      () => this.rejectResult(error),
    );
  }

  private async finishOwnedCleanup(error: ServerLaunchError): Promise<void> {
    try {
      await this.process.stop();
    } catch {
      this.rejectResult(new ServerLaunchError(error.code, 'retained'));
      return;
    }
    await this.process.completion.catch(() => undefined);
    this.rejectResult(error);
  }

  private async abandonAfterDetachFailure(): Promise<void> {
    await this.process.abandonUncertain().catch(() => undefined);
    this.rejectResult(new ServerLaunchError('START_OUTCOME_UNKNOWN'));
  }

  private claimTerminal(): boolean {
    if (this.state === 'terminal') {
      return false;
    }
    this.state = 'terminal';
    clearTimeout(this.timer);
    this.options.signal.removeEventListener('abort', this.aborted);
    this.unsubscribe();
    return true;
  }
}

function parseChildMessage(value: unknown): ServerHostChildMessage | undefined {
  if (!record(value) || value.protocol !== SERVER_HOST_PROTOCOL) {
    return undefined;
  }
  if (value.type === 'booted' && exact(value, ['protocol', 'type'])) {
    return { protocol: SERVER_HOST_PROTOCOL, type: 'booted' };
  }
  if (
    value.type === 'ready' &&
    exact(value, ['protocol', 'type', 'operationId', 'url']) &&
    typeof value.operationId === 'string' &&
    typeof value.url === 'string'
  ) {
    return {
      protocol: SERVER_HOST_PROTOCOL,
      type: 'ready',
      operationId: value.operationId,
      url: value.url,
    };
  }
  if (
    value.type === 'committed' &&
    exact(value, ['protocol', 'type', 'operationId']) &&
    typeof value.operationId === 'string'
  ) {
    return {
      protocol: SERVER_HOST_PROTOCOL,
      type: 'committed',
      operationId: value.operationId,
    };
  }
  if (value.type === 'failed' && failedMessage(value)) {
    return value;
  }
  return undefined;
}

function failedMessage(
  value: Record<string, unknown>,
): value is Extract<ServerHostChildMessage, { type: 'failed' }> & Record<string, unknown> {
  const fields =
    value.cleanup === undefined
      ? ['protocol', 'type', 'operationId', 'code']
      : ['protocol', 'type', 'operationId', 'code', 'cleanup'];
  return (
    exact(value, fields) &&
    typeof value.operationId === 'string' &&
    [
      'SERVER_HOST_BUSY',
      'REVO_ACTIVATION_STATE_INCOMPATIBLE',
      'SERVER_HOST_CANCELLED',
      'SERVER_HOST_FAILED',
      'SERVER_HOST_INVALID_MESSAGE',
      'SERVER_HOST_WRONG_OPERATION',
    ].includes(String(value.code)) &&
    (value.cleanup === undefined ||
      (typeof value.cleanup === 'string' &&
        ['completed', 'retained', 'unconfirmed'].includes(value.cleanup)))
  );
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exact = (value: Record<string, unknown>, fields: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
};
