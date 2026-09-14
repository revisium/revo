import { Injectable } from '@nestjs/common';

import { ManagedProcessService } from '../processes/managed-process.service.js';
import type { OwnedProcess, ProcessCompletion } from '../processes/managed-process.types.js';
import {
  CORE_HOST_PROTOCOL,
  parseCoreHostMessage,
  type CoreHostMessage,
  type CoreHostStageMessage,
  type CoreHostStartMessage,
} from './core-child-protocol.js';

const CLEANUP_MILLISECONDS = 3_000;
const GRACE_MILLISECONDS = 500;
const SEND_MILLISECONDS = 250;

export interface CoreHostProcessBinding {
  readonly cwd: string;
  readonly entry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executable: string;
}

export interface CoreHostStartOptions {
  readonly deadline: number;
  readonly onStage: (message: CoreHostStageMessage) => Promise<void>;
  readonly signal: AbortSignal;
}

type CoreHostProcessErrorCode =
  | 'revo.core-host.aborted'
  | 'revo.core-host.deadline'
  | 'revo.core-host.exited'
  | 'revo.core-host.failed'
  | 'revo.core-host.invalid-state'
  | 'revo.core-host.protocol'
  | 'revo.core-host.stage'
  | 'revo.core-host.stop';

type LifecyclePhase =
  | 'idle'
  | 'spawning'
  | 'booting'
  | 'starting'
  | 'draining'
  | 'listening'
  | 'stopping'
  | 'settled'
  | 'failed';

export class CoreHostProcessError extends Error {
  constructor(readonly code: CoreHostProcessErrorCode) {
    super('Core host process operation failed.');
    this.name = 'CoreHostProcessError';
  }
}

@Injectable()
export class CoreHostProcessService {
  constructor(private readonly processes = new ManagedProcessService()) {}

  open(binding: CoreHostProcessBinding): CoreHostProcessResource {
    return new CoreHostProcessResource(binding, this.processes);
  }
}

export class CoreHostProcessResource {
  private child: OwnedProcess | undefined;
  private spawnOperation: Promise<OwnedProcess> | undefined;
  private lateCleanup: Promise<void> | undefined;
  private completion: ProcessCompletion | undefined;
  private phase: LifecyclePhase = 'idle';
  private failure: CoreHostProcessError | undefined;
  private readonly messages: CoreHostMessage[] = [];
  private readonly wakeups = new Set<() => void>();
  private readonly terminal = deferred<void>();
  private stageDrain: Promise<void> = Promise.resolve();
  private stageMessages = 0;
  private protocolMessages = 0;

  constructor(
    private readonly binding: CoreHostProcessBinding,
    private readonly processes: ManagedProcessService,
  ) {}

  async start(message: CoreHostStartMessage, options: CoreHostStartOptions) {
    if (this.phase !== 'idle') {
      throw new CoreHostProcessError('revo.core-host.invalid-state');
    }
    if (options.signal.aborted) {
      throw new CoreHostProcessError('revo.core-host.aborted');
    }
    if (Date.now() >= options.deadline) {
      throw new CoreHostProcessError('revo.core-host.deadline');
    }
    this.phase = 'spawning';
    this.spawnOperation = this.processes
      .start({
        executable: this.binding.executable,
        args: [this.binding.entry],
        cwd: this.binding.cwd,
        env: this.binding.env,
        ipc: true,
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      })
      .then((child) => this.register(child));
    const abort = () => this.latch('revo.core-host.aborted');
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      const child = await this.waitForSpawn(options.deadline);
      this.throwIfUnavailable(options.signal, options.deadline);
      child.subscribe?.((value) => this.receive(value, options.onStage));
      this.phase = 'booting';
      await this.send({ protocol: CORE_HOST_PROTOCOL, type: 'hello' }, options.deadline);
      await this.waitFor('booted', options);
      this.throwIfUnavailable(options.signal, options.deadline);
      this.phase = 'starting';
      await this.send(message, options.deadline);
      const listening = await this.waitFor('listening', options);
      await this.drainStages(options.deadline);
      this.throwIfUnavailable(options.signal, options.deadline);
      this.phase = 'listening';
      return listening;
    } catch (error) {
      this.failure ??= normalizeError(error, options.signal, options.deadline);
      if (!this.child) {
        this.retainLateCleanup();
        throw this.failure;
      }
      await this.terminateWithFreshBudget();
      throw this.failure;
    } finally {
      options.signal.removeEventListener('abort', abort);
    }
  }

  close(deadline: number): Promise<void> {
    return this.terminate(deadline);
  }

  settled(): Promise<ProcessCompletion> {
    if (this.child) {
      return this.child.completion;
    }
    if (this.spawnOperation) {
      return this.spawnOperation.then((child) => child.completion);
    }
    return Promise.reject(new CoreHostProcessError('revo.core-host.invalid-state'));
  }

  assertRunning(): void {
    if (this.phase !== 'listening' || this.failure || this.completion) {
      throw new CoreHostProcessError('revo.core-host.exited');
    }
  }

  private register(child: OwnedProcess): OwnedProcess {
    this.child = child;
    void child.completion.then((completion) => {
      this.completion = completion;
      if (this.phase !== 'failed') {
        this.phase = 'settled';
      }
      this.terminal.resolve();
      this.wake();
    });
    if (this.phase === 'stopping' || this.failure) {
      this.lateCleanup ??= this.terminateWithFreshBudget();
      void this.lateCleanup.catch(() => undefined);
    }
    return child;
  }

  private receive(value: unknown, onStage: CoreHostStartOptions['onStage']): void {
    if (this.phase === 'stopping' || this.phase === 'settled' || this.phase === 'failed') {
      return;
    }
    const message = parseCoreHostMessage(value);
    if (!message || !this.allowed(message)) {
      return this.latch('revo.core-host.protocol');
    }
    this.protocolMessages += 1;
    if (this.protocolMessages > 10) {
      return this.latch('revo.core-host.protocol');
    }
    if (message.type === 'failed') {
      this.messages.push(message);
      this.latch('revo.core-host.failed');
      return;
    }
    if (message.type === 'stage') {
      this.stageMessages += 1;
      if (this.stageMessages > 8) {
        return this.latch('revo.core-host.protocol');
      }
      this.stageDrain = this.stageDrain.then(() => onStage(message));
      void this.stageDrain.catch(() => this.latch('revo.core-host.stage'));
    }
    if (message.type === 'listening') {
      this.phase = 'draining';
    }
    this.messages.push(message);
    this.wake();
  }

  private allowed(message: CoreHostMessage): boolean {
    if (this.phase === 'booting') {
      return message.type === 'booted' || message.type === 'failed';
    }
    if (this.phase === 'starting') {
      return message.type === 'stage' || message.type === 'listening' || message.type === 'failed';
    }
    return false;
  }

  private async waitFor<T extends 'booted' | 'listening'>(
    type: T,
    options: CoreHostStartOptions,
  ): Promise<Extract<CoreHostMessage, { readonly type: T }>> {
    this.throwIfUnavailable(options.signal, options.deadline);
    const index = this.messages.findIndex((message) => message.type === type);
    if (index >= 0) {
      const message = this.messages.splice(index, 1)[0];
      if (message && isLifecycleMessage(message, type)) {
        return message;
      }
    }
    await this.waitForWake(options.signal, options.deadline);
    return this.waitFor(type, options);
  }

  private waitForSpawn(deadline: number): Promise<OwnedProcess> {
    if (!this.spawnOperation) {
      return Promise.reject(new CoreHostProcessError('revo.core-host.invalid-state'));
    }
    const terminal = this.terminal.promise.then(() => {
      throw this.failure ?? new CoreHostProcessError('revo.core-host.invalid-state');
    });
    return untilDeadline(Promise.race([this.spawnOperation, terminal]), deadline);
  }

  private async drainStages(deadline: number): Promise<void> {
    const terminal = this.terminal.promise.then(() => {
      throw this.failure ?? new CoreHostProcessError('revo.core-host.exited');
    });
    await untilDeadline(Promise.race([this.stageDrain, terminal]), deadline);
    if (this.failure) {
      throw this.failure;
    }
  }

  private waitForWake(signal: AbortSignal, deadline: number): Promise<void> {
    return new Promise((resolveWake, rejectWake) => {
      const finish = (error?: CoreHostProcessError) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        this.wakeups.delete(changed);
        if (error) {
          rejectWake(error);
        } else {
          resolveWake();
        }
      };
      const changed = () => finish();
      const aborted = () => finish(new CoreHostProcessError('revo.core-host.aborted'));
      const timer = setTimeout(
        () => finish(new CoreHostProcessError('revo.core-host.deadline')),
        remaining(deadline),
      );
      this.wakeups.add(changed);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) {
        aborted();
      }
    });
  }

  private async send(message: CoreHostMessage, deadline: number): Promise<void> {
    if (!this.child?.send) {
      throw new CoreHostProcessError('revo.core-host.protocol');
    }
    await untilDeadline(
      this.child.send(message),
      Math.min(deadline, Date.now() + SEND_MILLISECONDS),
    );
  }

  private terminateWithFreshBudget(): Promise<void> {
    return this.terminate(Date.now() + CLEANUP_MILLISECONDS);
  }

  private async terminate(deadline: number): Promise<void> {
    this.phase = 'stopping';
    this.terminal.resolve();
    this.wake();
    let child = this.child;
    if (!child && this.spawnOperation) {
      try {
        child = await untilDeadline(this.spawnOperation, deadline);
      } catch {
        this.retainLateCleanup();
        throw new CoreHostProcessError('revo.core-host.stop');
      }
    }
    if (!child) {
      return;
    }
    try {
      await this.send({ protocol: CORE_HOST_PROTOCOL, type: 'shutdown' }, deadline);
    } catch {
      // Bounded managed termination remains authoritative.
    }
    if (
      await observesCompletion(
        child.completion,
        Math.min(deadline, Date.now() + GRACE_MILLISECONDS),
      )
    ) {
      return;
    }
    await this.stopChild(child, deadline);
    await untilDeadline(child.completion, deadline);
  }

  private async stopChild(child: OwnedProcess, deadline: number): Promise<void> {
    const available = remaining(deadline);
    const graceMs = Math.min(GRACE_MILLISECONDS, Math.floor(available / 2));
    try {
      await this.processes.stop(child, {
        graceMs,
        killWaitMs: Math.max(0, available - graceMs),
      });
    } catch {
      throw new CoreHostProcessError('revo.core-host.stop');
    }
  }

  private throwIfUnavailable(signal: AbortSignal, deadline: number): void {
    if (signal.aborted) {
      throw new CoreHostProcessError('revo.core-host.aborted');
    }
    if (Date.now() >= deadline) {
      throw new CoreHostProcessError('revo.core-host.deadline');
    }
    if (this.failure) {
      throw this.failure;
    }
    if (this.completion) {
      throw new CoreHostProcessError('revo.core-host.exited');
    }
    if (this.phase === 'stopping' || this.phase === 'failed') {
      throw new CoreHostProcessError('revo.core-host.invalid-state');
    }
  }

  private latch(code: CoreHostProcessErrorCode): void {
    this.failure ??= new CoreHostProcessError(code);
    this.phase = 'failed';
    this.terminal.resolve();
    this.wake();
  }

  private retainLateCleanup(): void {
    if (!this.spawnOperation) {
      return;
    }
    this.lateCleanup ??= this.spawnOperation.then(() => this.terminateWithFreshBudget());
    void this.lateCleanup.catch(() => undefined);
  }

  private wake(): void {
    for (const wakeup of this.wakeups) {
      wakeup();
    }
  }
}

function normalizeError(error: unknown, signal: AbortSignal, deadline: number) {
  if (error instanceof CoreHostProcessError) {
    return error;
  }
  if (signal.aborted) {
    return new CoreHostProcessError('revo.core-host.aborted');
  }
  return new CoreHostProcessError(
    Date.now() >= deadline ? 'revo.core-host.deadline' : 'revo.core-host.protocol',
  );
}

function isLifecycleMessage<T extends 'booted' | 'listening'>(
  message: CoreHostMessage,
  type: T,
): message is Extract<CoreHostMessage, { readonly type: T }> {
  return message.type === type;
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => (resolvePromise = resolve));
  return { promise, resolve: resolvePromise };
}

const remaining = (deadline: number) => Math.max(0, deadline - Date.now());

async function observesCompletion(completion: Promise<ProcessCompletion>, deadline: number) {
  try {
    await untilDeadline(completion, deadline);
    return true;
  } catch {
    return false;
  }
}

function untilDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const milliseconds = remaining(deadline);
  if (milliseconds === 0) {
    return Promise.reject(new CoreHostProcessError('revo.core-host.deadline'));
  }
  return new Promise<T>((resolveOperation, rejectOperation) => {
    const timer = setTimeout(
      () => rejectOperation(new CoreHostProcessError('revo.core-host.deadline')),
      milliseconds,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolveOperation(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectOperation(error);
      },
    );
  });
}
