import type { RevoCoreRuntime, RevoCoreRuntimeOptions } from '@revisium/revo-core/runtime';

import type { CoreHostMessage } from '../../../src/core-host/core-child-protocol.js';
import type { CoreChildTransport } from '../../../src/core-host/core-child-runner.js';
import { CoreRuntimeService } from '../../../src/core-host/core-runtime.service.js';

export class CoreHostScenario {
  readonly sent: CoreHostMessage[] = [];
  private failure: Error | undefined;

  send = async (message: CoreHostMessage): Promise<void> => {
    this.sent.push(message);
    if (this.failure) {
      throw this.failure;
    }
  };

  failSending(message = 'transport unavailable') {
    this.failure = new Error(message);
  }
}

export class CoreChildScenario implements CoreChildTransport {
  readonly sent: CoreHostMessage[] = [];
  finished: number | undefined;
  finishCalls = 0;
  private finishPromise: Promise<void>;
  private resolveFinish!: () => void;
  private sendFailure: Error | undefined;

  constructor() {
    this.finishPromise = new Promise((resolve) => (this.resolveFinish = resolve));
  }
  send = async (message: CoreHostMessage) => {
    this.sent.push(message);
    if (this.sendFailure) {
      throw this.sendFailure;
    }
  };
  finish = (exitCode: 0 | 1 | 2) => {
    this.finishCalls += 1;
    this.finished = exitCode;
    this.resolveFinish();
  };
  settled() {
    return this.finishPromise;
  }
  settledWithin(milliseconds = 250) {
    return Promise.race([
      this.finishPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('runner did not finish')), milliseconds),
      ),
    ]);
  }
  failSending(message = 'SECRET transport failure') {
    this.sendFailure = new Error(message);
  }
  async untilListening(): Promise<void> {
    if (this.sent.some((message) => message.type === 'listening')) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await this.untilListening();
  }
}

export class DeferredCoreRuntimeService extends CoreRuntimeService {
  private observer: RevoCoreRuntimeOptions['onStage'];
  private resolve!: (runtime: RevoCoreRuntime) => void;
  private reject!: (error: Error) => void;
  private readonly factory = new Promise<RevoCoreRuntime>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });

  resolveFactory(options: FakeRuntimeOptions = {}) {
    const runtime = new FakeRuntime(() => this.observer, options);
    this.resolve(runtime);
    return runtime;
  }
  rejectFactory(error = new Error('SECRET factory failure')) {
    this.reject(error);
  }
  protected override createRuntime(options: RevoCoreRuntimeOptions): Promise<RevoCoreRuntime> {
    this.observer = options.onStage;
    return this.factory;
  }
}

interface FakeRuntimeOptions {
  readonly closeRejects?: boolean;
  readonly listenHeld?: boolean;
  readonly prepareHeld?: boolean;
  readonly prepareRejects?: boolean;
}

class FakeRuntime implements RevoCoreRuntime {
  declare readonly app: RevoCoreRuntime['app'];
  closeCalls = 0;
  listenCalls = 0;
  prepareCalls = 0;
  private readonly prepareGate = deferred();
  private readonly listenGate = deferred();
  constructor(
    private readonly observer: () => RevoCoreRuntimeOptions['onStage'],
    private readonly options: FakeRuntimeOptions,
  ) {}
  async prepareDatabase(options?: { readonly signal?: AbortSignal }) {
    this.prepareCalls += 1;
    this.observer()?.({ stage: 'application-database-migrations', status: 'started' });
    if (this.options.prepareHeld) {
      await abortable(this.prepareGate.promise, options?.signal);
    }
    if (this.options.prepareRejects) {
      throw new Error('SECRET prepare failure');
    }
    this.observer()?.({ stage: 'application-database-migrations', status: 'completed' });
  }
  configureAfterCoreRoutes() {}
  async initialize() {}
  async listen() {
    this.listenCalls += 1;
    this.observer()?.({ stage: 'api-readiness', status: 'started' });
    if (this.options.listenHeld) {
      await this.listenGate.promise;
    }
    this.observer()?.({ stage: 'api-readiness', status: 'completed' });
    return { host: '127.0.0.1', port: 49152, url: 'http://127.0.0.1:49152' };
  }
  async close() {
    this.closeCalls += 1;
    if (this.options.closeRejects) {
      throw new Error('SECRET close failure');
    }
  }
  releasePrepare() {
    this.prepareGate.resolve();
  }
  releaseListen() {
    this.listenGate.resolve();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function abortable(operation: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return operation;
  }
  if (signal.aborted) {
    return Promise.reject(new Error('SECRET aborted preparation'));
  }
  return Promise.race([
    operation,
    new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('SECRET aborted preparation')), {
        once: true,
      }),
    ),
  ]);
}
