import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { onTestFinished } from 'vitest';

import {
  ServerHostEntry,
  type ServerHostOwnerPort,
} from '../../../src/server/server-host-entry.js';
import type { ServerHostProcessPort } from '../../../src/server/server-host-process-port.js';
import {
  SERVER_HOST_PROTOCOL,
  type ServerHostChildMessage,
  type ServerHostParentMessage,
} from '../../../src/server/server-host-protocol.js';
import type { ServerOwnerOutcome } from '../../../src/server/server-owner.service.js';
import { OPERATION_ID, validStartMessage } from './server-host-message.js';

const IPC_CHILD = resolvePath(dirname(fileURLToPath(import.meta.url)), 'server-host-ipc-child.mjs');

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: Error) => void;
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class Owner implements ServerHostOwnerPort {
  closeCalls = 0;
  startCalls = 0;
  readonly closeCompleted = new Deferred<void>();
  readonly released = new Deferred<void>();
  readonly startEntered = new Deferred<void>();
  private readonly startResult = new Deferred<{ readonly kind: 'ready'; readonly url: string }>();
  private readonly ownerOutcome = new Deferred<ServerOwnerOutcome>();

  start(_signal: AbortSignal) {
    this.startCalls += 1;
    this.startEntered.resolve();
    return this.startResult.promise;
  }
  close() {
    this.closeCalls += 1;
    this.released.resolve();
    this.ownerOutcome.resolve({ kind: 'stopped' });
    this.closeCompleted.resolve();
    return this.closeCompleted.promise;
  }
  outcome() {
    return this.ownerOutcome.promise;
  }
  ownershipReleased() {
    return this.released.promise;
  }
  becomeReady() {
    this.startResult.resolve({ kind: 'ready', url: 'http://127.0.0.1:3210' });
  }
  complete(outcome: ServerOwnerOutcome) {
    this.ownerOutcome.resolve(outcome);
  }
  releaseOwnership() {
    this.released.resolve();
  }
}

class ProcessPort implements ServerHostProcessPort {
  readonly sent: ServerHostChildMessage[] = [];
  readonly ackAttempted = new Deferred<void>();
  readonly ackDelivered = new Deferred<void>();
  readonly ackSettled = new Deferred<'deadline' | 'delivered'>();
  readonly bootedDelivered = new Deferred<void>();
  readonly readyAttempted = new Deferred<void>();
  readonly readyDelivered = new Deferred<void>();
  readonly readySettled = new Deferred<'delivered' | 'rejected'>();
  readonly settled = new Deferred<0 | 1 | 2>();
  readonly terminalClosed = new Deferred<void>();
  readonly committedDeadlines: number[] = [];
  readonly readyDeadlines: number[] = [];
  connectedValue = true;
  holdCommitted = false;
  holdReady = false;
  exitCode: number | undefined;
  closeCalls = 0;
  private readonly heldAck = new Deferred<void>();
  private readonly heldReady = new Deferred<void>();
  private disconnectListener: () => void = () => {};
  private messageListener: (message: unknown) => void = () => {};
  private signalListener: () => void = () => {};
  private signalled = false;

  connected() {
    return this.connectedValue;
  }
  onDisconnect(listener: () => void) {
    this.disconnectListener = listener;
  }
  onMessage(listener: (message: unknown) => void) {
    this.messageListener = listener;
  }
  onSignal(listener: () => void) {
    this.signalListener = listener;
    if (this.signalled) {
      listener();
    }
  }
  async send(message: ServerHostChildMessage, deadline: number) {
    this.sent.push(message);
    if (message.type === 'booted') {
      this.bootedDelivered.resolve();
    }
    if (message.type === 'ready') {
      this.readyDeadlines.push(deadline);
      this.readyAttempted.resolve();
      if (this.holdReady) {
        try {
          await this.heldReady.promise;
        } catch (error) {
          this.readySettled.resolve('rejected');
          throw error;
        }
      }
      this.readyDelivered.resolve();
      this.readySettled.resolve('delivered');
    }
    if (message.type !== 'committed') {
      return;
    }
    this.committedDeadlines.push(deadline);
    this.ackAttempted.resolve();
    if (this.holdCommitted) {
      await Promise.race([
        this.heldAck.promise,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('fixture send deadline')),
            Math.max(0, deadline - Date.now()),
          ),
        ),
      ]).catch((error: unknown) => {
        this.ackSettled.resolve('deadline');
        throw error;
      });
    }
    this.ackDelivered.resolve();
    this.ackSettled.resolve('delivered');
  }
  setExitCode(exitCode: 0 | 1 | 2) {
    this.exitCode = exitCode;
    this.settled.resolve(exitCode);
  }
  close(_deadline: number) {
    this.closeCalls += 1;
    this.terminalClosed.resolve();
    return this.terminalClosed.promise;
  }
  deliver(message: unknown) {
    this.messageListener(message);
  }
  releaseAck() {
    this.heldAck.resolve();
  }
  rejectReady() {
    this.heldReady.reject(new Error('fixture ready rejection'));
  }
  disconnect() {
    this.connectedValue = false;
    this.disconnectListener();
  }
  signal() {
    this.signalled = true;
    this.signalListener();
  }
}

export class ServerHostScenario {
  readonly owner = new Owner();
  readonly process = new ProcessPort();
  readonly openEntered = new Deferred<void>();
  private readonly openResult = new Deferred<'busy' | ServerHostOwnerPort>();
  private readonly entry = new ServerHostEntry(this.process, {
    open: () => {
      this.openEntered.resolve();
      return this.openResult.promise;
    },
  });

  private startFailure: { error: unknown } | undefined;
  start() {
    onTestFinished(() => {
      if (this.startFailure) {
        throw this.startFailure.error;
      }
    });
    void this.entry.start().then(
      () => undefined,
      (error: unknown) => {
        this.startFailure = { error };
      },
    );
  }
  allowOwner() {
    this.openResult.resolve(this.owner);
  }
  reportBusy() {
    this.openResult.resolve('busy');
  }
  becomeReady() {
    this.owner.becomeReady();
  }
  sendStart(mode: 'detached' | 'foreground' = 'detached', startupTimeout = 5_000) {
    this.process.deliver(
      validStartMessage({
        mode,
        configuration: { ...validStartMessage().configuration, startupTimeout },
      }),
    );
  }
  commit(operationId = OPERATION_ID) {
    this.process.deliver(operation('commit', operationId));
  }
  cancel(operationId = OPERATION_ID) {
    this.process.deliver(operation('cancel', operationId));
  }
  malformed(message: unknown = { protocol: SERVER_HOST_PROTOCOL, type: 'start' }) {
    this.process.deliver(message);
  }
  disconnect() {
    this.process.disconnect();
  }
  messages(type: ServerHostChildMessage['type']) {
    return this.process.sent.filter((message) => message.type === type);
  }
}

function operation(type: 'commit' | 'cancel', operationId: string): ServerHostParentMessage {
  return { protocol: SERVER_HOST_PROTOCOL, type, operationId };
}

export async function realIpcDisconnectBeforeOwnerOpens() {
  const root = await mkdtemp(join(tmpdir(), 'revo-server-host-ipc-'));
  const deadline = Date.now() + 3_000;
  const child = fork(IPC_CHILD, [], {
    env: { REVO_SERVER_HOST_ROOT: root },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })),
  );
  let observedExit = false;
  void completion.then(() => (observedExit = true));
  let cleanupCompleted = false;
  let result:
    | {
        readonly completion: { code: number | null; signal: NodeJS.Signals | null };
        readonly cleanup: string;
        readonly terminalBeforeRelease: boolean;
      }
    | undefined;
  let operationError: unknown;
  let cleanupError: unknown;
  try {
    try {
      await beforeDeadline(
        new Promise<void>((resolveBooted, rejectBooted) => {
          child.once('error', rejectBooted);
          child.once('message', (message: unknown) => {
            if (
              typeof message !== 'object' ||
              message === null ||
              !('type' in message) ||
              message.type !== 'booted'
            ) {
              rejectBooted(new Error('Unexpected server host boot message'));
              return;
            }
            child.send(validStartMessage(), (error) =>
              error ? rejectBooted(error) : resolveBooted(),
            );
          });
        }),
        deadline,
      );
      await waitForFile(join(root, 'open-entered'), deadline);
      child.disconnect();
      await waitForFile(join(root, 'disconnect-observed'), deadline);
      await writeFile(join(root, 'allow-owner'), 'allow-owner');
      await waitForFile(join(root, 'close-entered'), deadline);
      const terminalBeforeRelease = await fileExists(join(root, 'entry-completed'));
      await writeFile(join(root, 'release-close'), 'release-close');
      await waitForFile(join(root, 'entry-completed'), deadline);
      const exit = await beforeDeadline(completion, deadline);
      observedExit = true;
      const cleanup = await readFile(join(root, 'closed'), 'utf8');
      cleanupCompleted = true;
      result = { completion: exit, cleanup, terminalBeforeRelease };
    } catch (error: unknown) {
      operationError = error;
    }
  } finally {
    try {
      if (!observedExit) {
        const cleanupDeadline = Date.now() + 3_000;
        let gateFailure = false;
        await beforeDeadline(
          Promise.all([
            writeFile(join(root, 'allow-owner'), 'allow-owner'),
            writeFile(join(root, 'release-close'), 'release-close'),
          ]),
          Math.min(cleanupDeadline, Date.now() + 500),
        ).catch(() => (gateFailure = true));
        child.kill('SIGTERM');
        try {
          await beforeDeadline(completion, Math.min(cleanupDeadline, Date.now() + 1_000));
        } catch {
          child.kill('SIGKILL');
          await beforeDeadline(completion, cleanupDeadline);
        }
        observedExit = true;
        if (gateFailure) {
          cleanupError = new Error('Server host fixture cleanup gates failed');
        }
      }
      if (cleanupCompleted && observedExit) {
        await rm(root, { recursive: true, force: true });
      }
    } catch (error: unknown) {
      cleanupError = error;
    }
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  if (result === undefined) {
    throw new Error('Server host fixture completed without a result');
  }
  return result;
}

async function waitForFile(path: string, deadline: number): Promise<void> {
  if (await fileExists(path)) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error('Server host IPC fixture deadline exceeded');
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  await waitForFile(path, deadline);
}

const fileExists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

function beforeDeadline<T>(pending: Promise<T>, deadline: number): Promise<T> {
  if (Date.now() >= deadline) {
    return Promise.reject(new Error('Server host IPC fixture deadline exceeded'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Server host IPC fixture deadline exceeded')),
      Math.max(0, deadline - Date.now()),
    );
    void pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
