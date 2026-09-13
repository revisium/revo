import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';

import { ManagedProcessError } from './managed-process-error.js';
import type {
  ManagedProcessRequest,
  OwnedProcess,
  ProcessCompletion,
  ProcessCancellationResult,
  ProcessMessage,
  ProcessStdio,
  StopProcessRequest,
} from './managed-process.types.js';
import { ProcessExitWaiter } from './process-exit-waiter.js';

const MAX_TIMER_MILLISECONDS = 2_147_483_647;

@Injectable()
export class ManagedProcessService {
  constructor(
    @Inject(ProcessExitWaiter)
    private readonly exitWaiter: ProcessExitWaiter = new ProcessExitWaiter(),
  ) {}

  async start(request: ManagedProcessRequest): Promise<OwnedProcess> {
    this.validateRequest(request);
    if (request.cancellation?.signal.aborted === true) {
      throw new ManagedProcessError('revo.process.cancelled', 'Process start was cancelled.');
    }

    let child: ChildProcess;
    try {
      child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: { ...request.env },
        shell: false,
        stdio: this.spawnStdio(request),
      });
    } catch {
      throw new ManagedProcessError('revo.process.spawn', 'Unable to spawn the managed process.');
    }
    const handle = new ManagedOwnedProcess(child, request, this.exitWaiter);
    await handle.waitForSpawn(request.cancellation);
    return handle;
  }

  async stop(handle: OwnedProcess, request: StopProcessRequest): Promise<void> {
    this.validateDuration(request.graceMs, 'graceMs');
    this.validateDuration(request.killWaitMs, 'killWaitMs');
    if (!(handle instanceof ManagedOwnedProcess)) {
      throw new ManagedProcessError('revo.process.invalid', 'Process handle is not owned.');
    }
    await handle.stop(request);
  }

  private spawnStdio(request: ManagedProcessRequest): StdioOptions {
    return request.ipc === true
      ? [request.stdio.stdin, request.stdio.stdout, request.stdio.stderr, 'ipc']
      : [request.stdio.stdin, request.stdio.stdout, request.stdio.stderr];
  }

  private validateRequest(request: ManagedProcessRequest): void {
    if (!path.isAbsolute(request.executable)) {
      throw new ManagedProcessError(
        'revo.process.invalid',
        'Process executable must be an absolute path.',
      );
    }
    if (!path.isAbsolute(request.cwd)) {
      throw new ManagedProcessError(
        'revo.process.invalid',
        'Process working directory must be an absolute path.',
      );
    }
    if (
      !Array.isArray(request.args) ||
      request.args.some((argument) => typeof argument !== 'string')
    ) {
      throw new ManagedProcessError('revo.process.invalid', 'Process arguments must be strings.');
    }
    if (typeof request.env !== 'object' || request.env === null || Array.isArray(request.env)) {
      throw new ManagedProcessError(
        'revo.process.invalid',
        'Process environment must be explicit.',
      );
    }
    if (Object.values(request.env).some((value) => typeof value !== 'string')) {
      throw new ManagedProcessError(
        'revo.process.invalid',
        'Process environment values must be strings.',
      );
    }
    for (const value of Object.values(request.stdio)) {
      this.validateStdio(value);
    }
    if (request.cancellation !== undefined) {
      this.validateDuration(request.cancellation.graceMs, 'cancellation.graceMs');
      this.validateDuration(request.cancellation.killWaitMs, 'cancellation.killWaitMs');
    }
  }

  private validateStdio(value: ProcessStdio): void {
    if (
      !['ignore', 'inherit', 'pipe'].includes(String(value)) &&
      (!Number.isInteger(value) || Number(value) < 0)
    ) {
      throw new ManagedProcessError('revo.process.invalid', 'Process stdio is invalid.');
    }
  }

  private validateDuration(value: number, field: string): void {
    if (!Number.isInteger(value) || value < 0 || value > MAX_TIMER_MILLISECONDS) {
      throw new ManagedProcessError(
        'revo.process.invalid',
        `Process ${field} must be a non-negative integer.`,
      );
    }
  }
}

class ManagedOwnedProcess implements OwnedProcess {
  readonly cancellationResult?: Promise<ProcessCancellationResult>;
  readonly completion: Promise<ProcessCompletion>;
  readonly send?: (message: ProcessMessage) => Promise<void>;
  readonly stderr?: Readable;
  readonly stdin?: Writable;
  readonly stdout?: Readable;
  readonly subscribe?: (listener: (message: unknown) => void) => () => void;
  private exited = false;
  private stopOperation: Promise<void> | undefined;
  private readonly abortListener: (() => void) | undefined;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly childErrorListener = noop;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private cancellationRequested = false;
  private resolveCancellation: ((result: ProcessCancellationResult) => void) | undefined;

  constructor(
    private readonly child: ChildProcess,
    request: ManagedProcessRequest,
    private readonly exitWaiter: ProcessExitWaiter,
  ) {
    this.completion = new Promise((resolveCompletion) => {
      child.once('exit', (exitCode, signal) => {
        this.exited = true;
        this.disposeListeners();
        resolveCompletion({ exitCode, signal });
        if (!this.cancellationRequested) {
          this.resolveCancellation?.({ kind: 'not-requested' });
        }
      });
    });
    child.on('error', this.childErrorListener);
    if (child.stdin !== null) {
      this.stdin = child.stdin;
    }
    if (child.stdout !== null) {
      this.stdout = child.stdout;
    }
    if (child.stderr !== null) {
      this.stderr = child.stderr;
    }
    const cancellation = request.cancellation;
    if (cancellation !== undefined) {
      this.cancellationResult = new Promise((resolveCancellation) => {
        this.resolveCancellation = resolveCancellation;
      });
    }
    this.abortSignal = cancellation?.signal;
    this.abortListener =
      cancellation === undefined
        ? undefined
        : () => {
            this.cancellationRequested = true;
            void this.stop(cancellation).then(
              () => this.resolveCancellation?.({ kind: 'stopped' }),
              (error: unknown) =>
                this.resolveCancellation?.({ kind: 'failed', error: this.stopError(error) }),
            );
          };
    request.cancellation?.signal.addEventListener('abort', this.abortListener ?? noop, {
      once: true,
    });
    if (request.ipc === true) {
      this.send = (message) => this.sendMessage(message);
      this.subscribe = (listener) => this.subscribeToMessages(listener);
    }
  }

  async waitForSpawn(cancellation: ManagedProcessRequest['cancellation']): Promise<void> {
    await new Promise<void>((resolveSpawn, reject) => {
      const onSpawn = (): void => {
        cleanup();
        resolveSpawn();
      };
      const onError = (): void => {
        cleanup();
        this.disposeListeners();
        reject(
          new ManagedProcessError('revo.process.spawn', 'Unable to spawn the managed process.'),
        );
      };
      const onAbort = (): void => {
        cleanup();
        if (cancellation !== undefined) {
          void this.stop(cancellation).then(() => {
            reject(
              new ManagedProcessError('revo.process.cancelled', 'Process start was cancelled.'),
            );
          }, reject);
        }
      };
      const cleanup = (): void => {
        this.child.off('spawn', onSpawn);
        this.child.off('error', onError);
        cancellation?.signal.removeEventListener('abort', onAbort);
      };
      this.child.once('spawn', onSpawn);
      this.child.once('error', onError);
      cancellation?.signal.addEventListener('abort', onAbort, { once: true });
      if (cancellation?.signal.aborted === true) {
        onAbort();
      }
    });
  }

  private sendMessage(message: ProcessMessage): Promise<void> {
    if (!this.child.connected) {
      return Promise.reject(
        new ManagedProcessError('revo.process.invalid', 'Managed process IPC is unavailable.'),
      );
    }
    return new Promise((resolveSend, reject) => {
      this.child.send(message, (error) => {
        if (error === null) {
          resolveSend();
        } else {
          reject(error);
        }
      });
    });
  }

  private subscribeToMessages(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    this.child.on('message', listener);
    return () => {
      this.messageListeners.delete(listener);
      this.child.off('message', listener);
    };
  }

  stop(request: StopProcessRequest): Promise<void> {
    return (this.stopOperation ??= this.performStop(request));
  }

  private async performStop(request: StopProcessRequest): Promise<void> {
    if (this.exited) {
      return;
    }
    this.signal('SIGTERM');
    if (await this.exitWaiter.wait(this.completion, request.graceMs)) {
      return;
    }
    this.signal('SIGKILL');
    if (!(await this.exitWaiter.wait(this.completion, request.killWaitMs))) {
      throw new ManagedProcessError(
        'revo.process.stop-timeout',
        'Managed process did not exit after KILL.',
      );
    }
  }

  private signal(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch {
      throw new ManagedProcessError('revo.process.stop', 'Unable to signal the managed process.');
    }
  }

  private stopError(error: unknown): ManagedProcessError {
    return error instanceof ManagedProcessError
      ? error
      : new ManagedProcessError('revo.process.stop', 'Unable to stop the managed process.');
  }

  private disposeListeners(): void {
    this.child.off('error', this.childErrorListener);
    this.abortSignal?.removeEventListener('abort', this.abortListener ?? noop);
    for (const listener of this.messageListeners) {
      this.child.off('message', listener);
    }
    this.messageListeners.clear();
  }
}

function noop(): void {}
