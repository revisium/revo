import { vi } from 'vitest';

import {
  SERVER_HOST_PROTOCOL,
  type ServerHostChildMessage,
  type ServerHostParentMessage,
  type ServerHostStartMessage,
} from '../../../src/server/server-host-protocol.js';

const ATTEMPT_URL = new URL('../../../src/server/server-launch-attempt.js', import.meta.url).href;
export const OPERATION_ID = '0123456789abcdef0123456789abcdef';
export const PUBLIC_URL = 'http://127.0.0.1:3210';

interface AttemptModule {
  readonly ServerLaunchAttempt: new (process: AttemptProcessPort) => {
    start(
      message: ServerHostStartMessage,
      options: { readonly deadline: number; readonly signal: AbortSignal },
    ): Promise<{ readonly kind: 'started'; readonly url: string }>;
  };
}

interface AttemptProcessPort {
  readonly completion: Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  send(message: ServerHostParentMessage): Promise<void>;
  subscribe(listener: (message: unknown) => void): () => void;
  stop(): Promise<void>;
  detachCommitted(): Promise<void>;
  abandonUncertain(): Promise<void>;
}

type SendKind = ServerHostParentMessage['type'];

export class ServerLaunchAttemptScenario {
  readonly process = new ControlledAttemptProcess();
  readonly cancellation = new AbortController();
  private attempt:
    | {
        start(
          message: ServerHostStartMessage,
          options: { readonly deadline: number; readonly signal: AbortSignal },
        ): Promise<{ readonly kind: 'started'; readonly url: string }>;
      }
    | undefined;
  private operation: Promise<unknown> | undefined;

  async load(): Promise<this> {
    const { ServerLaunchAttempt } = await vi.importActual<AttemptModule>(ATTEMPT_URL);
    this.attempt = new ServerLaunchAttempt(this.process);
    return this;
  }

  start(timeoutMs = 5_000): Promise<unknown> {
    if (!this.attempt) {
      throw new Error('Launch attempt scenario was not loaded.');
    }
    this.operation = this.attempt.start(startMessage(), {
      deadline: Date.now() + timeoutMs,
      signal: this.cancellation.signal,
    });
    return this.operation;
  }

  result(): Promise<unknown> {
    if (!this.operation) {
      throw new Error('Launch attempt was not started.');
    }
    return this.operation;
  }

  booted(): void {
    this.process.receive({ protocol: SERVER_HOST_PROTOCOL, type: 'booted' });
  }

  ready(overrides: Partial<Extract<ServerHostChildMessage, { type: 'ready' }>> = {}): void {
    this.process.receive({
      protocol: SERVER_HOST_PROTOCOL,
      type: 'ready',
      operationId: OPERATION_ID,
      url: PUBLIC_URL,
      ...overrides,
    });
  }

  committed(overrides: Partial<Extract<ServerHostChildMessage, { type: 'committed' }>> = {}): void {
    this.process.receive({
      protocol: SERVER_HOST_PROTOCOL,
      type: 'committed',
      operationId: OPERATION_ID,
      ...overrides,
    });
  }

  failed(
    code: Extract<ServerHostChildMessage, { type: 'failed' }>['code'] = 'SERVER_HOST_FAILED',
    cleanup?: 'completed' | 'retained' | 'unconfirmed',
  ): void {
    this.process.receive({
      protocol: SERVER_HOST_PROTOCOL,
      type: 'failed',
      operationId: OPERATION_ID,
      code,
      ...(cleanup ? { cleanup } : {}),
    });
  }

  malformed(value: unknown = { protocol: SERVER_HOST_PROTOCOL, type: 'ready', secret: 'hidden' }) {
    this.process.receive(value);
  }

  abort(): void {
    this.cancellation.abort();
  }

  deliver(kind: SendKind): void {
    this.process.settleSend(kind, 'delivered');
  }

  reject(kind: SendKind): void {
    this.process.settleSend(kind, 'rejected');
  }

  exit(exitCode = 1): void {
    this.process.exit(exitCode);
  }

  sent(kind?: SendKind): readonly ServerHostParentMessage[] {
    return kind ? this.process.sent.filter((message) => message.type === kind) : this.process.sent;
  }
}

export class ControlledAttemptProcess implements AttemptProcessPort {
  readonly sent: ServerHostParentMessage[] = [];
  stopCalls = 0;
  detachCommittedCalls = 0;
  abandonUncertainCalls = 0;
  subscribedBeforeFirstSend = false;
  private readonly listeners = new Set<(message: unknown) => void>();
  private readonly sends = new Map<SendKind, Deferred<void>[]>();
  private stopGate: Deferred<void> | undefined;
  private readonly completionGate = deferred<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }>();
  readonly completion = this.completionGate.promise;

  send(message: ServerHostParentMessage): Promise<void> {
    if (this.sent.length === 0) {
      this.subscribedBeforeFirstSend = this.listeners.size > 0;
    }
    this.sent.push(message);
    const gate = deferred<void>();
    const queue = this.sends.get(message.type) ?? [];
    queue.push(gate);
    this.sends.set(message.type, queue);
    return gate.promise;
  }

  subscribe(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.stopGate) {
      await this.stopGate.promise;
    }
    await this.completion;
  }

  holdStop(): void {
    this.stopGate = deferred<void>();
  }

  rejectStop(): void {
    this.stopGate?.reject(new Error('private stop failed with secret'));
  }

  async detachCommitted(): Promise<void> {
    this.detachCommittedCalls += 1;
  }

  async abandonUncertain(): Promise<void> {
    this.abandonUncertainCalls += 1;
  }

  receive(message: unknown): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  settleSend(kind: SendKind, outcome: 'delivered' | 'rejected'): void {
    const gate = this.sends.get(kind)?.shift();
    if (!gate) {
      throw new Error(`No pending ${kind} send.`);
    }
    if (outcome === 'delivered') {
      gate.resolve();
    } else {
      gate.reject(new Error('private send failed with secret'));
    }
  }

  exit(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    this.completionGate.resolve({ exitCode, signal });
  }
}

export function startMessage(): ServerHostStartMessage {
  return {
    protocol: SERVER_HOST_PROTOCOL,
    type: 'start',
    operationId: OPERATION_ID,
    mode: 'detached',
    configuration: {
      channel: 'stable',
      dataDir: '/private/data',
      host: '127.0.0.1',
      port: 3210,
      publicUrl: PUBLIC_URL,
      runtimeDir: '/private/run',
      startupTimeout: 5_000,
      version: '1.2.3',
    },
    environment: { HOME: '/private/home', SECRET: 'never disclose' },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export async function turn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
