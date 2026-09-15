import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, vi } from 'vitest';

import { ManagedProcessError } from '../../../src/processes/managed-process-error.js';
import { ManagedProcessService } from '../../../src/processes/managed-process.service.js';
import type {
  ManagedProcessRequest,
  OwnedProcess,
  ProcessCompletion,
  StopProcessRequest,
} from '../../../src/processes/managed-process.types.js';
import type { ServerHostParentMessage } from '../../../src/server/server-host-protocol.js';
import type { ServerLaunchProcessPort } from '../../../src/server/server-launch-attempt.js';

const MODULE_URL = new URL('../../../src/server/server-launch-process.service.js', import.meta.url)
  .href;
const CHILD = fileURLToPath(new URL('./server-launch-process-child.mjs', import.meta.url));
const scenarios = new Set<ServerLaunchProcessScenario>();

afterEach(async () => {
  await Promise.all([...scenarios].map((scenario) => scenario.cleanup()));
  scenarios.clear();
});

interface LaunchBinding {
  readonly cwd: string;
  readonly entry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executable: string;
}

interface LaunchOptions {
  readonly graceMs: number;
  readonly killWaitMs: number;
  readonly signal: AbortSignal;
}

interface LaunchProcessModule {
  readonly ServerLaunchProcessService: new (processes?: ManagedProcessService) => {
    start(binding: LaunchBinding, options: LaunchOptions): Promise<ServerLaunchProcessPort>;
  };
}

interface Waiter {
  readonly predicate: (message: unknown) => boolean;
  readonly resolve: (message: unknown) => void;
}

class RecordingManagedProcessService extends ManagedProcessService {
  readonly requests: ManagedProcessRequest[] = [];

  override start(request: ManagedProcessRequest): Promise<OwnedProcess> {
    this.requests.push(request);
    return super.start(request);
  }
}

class MissingCapabilityManagedProcessService extends ManagedProcessService {
  readonly stopRequests: StopProcessRequest[] = [];
  readonly observedCompletion: Promise<ProcessCompletion>;
  private resolveCompletion!: (completion: ProcessCompletion) => void;

  constructor() {
    super();
    this.observedCompletion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  override async start(): Promise<OwnedProcess> {
    return { completion: this.observedCompletion };
  }

  override async stop(_handle: OwnedProcess, request: StopProcessRequest): Promise<void> {
    this.stopRequests.push(request);
    this.resolveCompletion({ exitCode: 0, signal: null });
  }
}

export interface MissingCapabilityOutcome {
  readonly completion: ProcessCompletion;
  readonly error: unknown;
  readonly stopRequests: readonly StopProcessRequest[];
}

export async function launchWithMissingCapability(): Promise<MissingCapabilityOutcome> {
  const managedProcesses = new MissingCapabilityManagedProcessService();
  const { ServerLaunchProcessService } = await vi.importActual<LaunchProcessModule>(MODULE_URL);
  const service = new ServerLaunchProcessService(managedProcesses);
  const error = await service
    .start(
      { executable: process.execPath, entry: CHILD, cwd: tmpdir(), env: {} },
      { signal: new AbortController().signal, graceMs: 25, killWaitMs: 500 },
    )
    .then(
      () => undefined,
      (caught: unknown) => caught,
    );
  return {
    error,
    stopRequests: managedProcesses.stopRequests,
    completion: await bounded(managedProcesses.observedCompletion),
  };
}

export type StopInteractionCase =
  | 'stop-rejects-completion-pending'
  | 'stop-resolves-completion-rejects';

class StopInteractionManagedProcessService extends ManagedProcessService {
  private rejectCompletion: ((error: unknown) => void) | undefined;

  constructor(private readonly interaction: StopInteractionCase) {
    super();
  }

  override async start(): Promise<OwnedProcess> {
    const completion = new Promise<ProcessCompletion>((_resolve, reject) => {
      this.rejectCompletion = reject;
    });
    completion.catch(() => undefined);
    return { completion };
  }

  override async stop(): Promise<void> {
    if (this.interaction === 'stop-rejects-completion-pending') {
      throw new ManagedProcessError(
        'revo.process.stop-timeout',
        'Managed process did not exit after KILL.',
      );
    }
    this.rejectCompletion?.(new Error('completion observation failed'));
  }
}

export async function launchWithStopInteraction(
  interaction: StopInteractionCase,
): Promise<unknown> {
  const managedProcesses = new StopInteractionManagedProcessService(interaction);
  const { ServerLaunchProcessService } = await vi.importActual<LaunchProcessModule>(MODULE_URL);
  const service = new ServerLaunchProcessService(managedProcesses);
  return bounded(
    service
      .start(
        { executable: process.execPath, entry: CHILD, cwd: tmpdir(), env: {} },
        { signal: new AbortController().signal, graceMs: 25, killWaitMs: 500 },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      ),
  );
}

export class ServerLaunchProcessScenario {
  private readonly root: string;
  private readonly eventsPath: string;
  private readonly controller = new AbortController();
  private readonly managedProcesses = new RecordingManagedProcessService();
  private readonly received: unknown[] = [];
  private readonly waiters = new Set<Waiter>();
  private port: ServerLaunchProcessPort | undefined;

  private constructor(root: string) {
    this.root = root;
    this.eventsPath = join(root, 'events.jsonl');
    scenarios.add(this);
  }

  static async create(): Promise<ServerLaunchProcessScenario> {
    const { mkdtemp } = await import('node:fs/promises');
    return new ServerLaunchProcessScenario(await mkdtemp(join(tmpdir(), 'revo-launch-process-')));
  }

  async start(overrides: Partial<LaunchBinding> = {}): Promise<ServerLaunchProcessPort> {
    const { ServerLaunchProcessService } = await vi.importActual<LaunchProcessModule>(MODULE_URL);
    const service = new ServerLaunchProcessService(this.managedProcesses);
    this.port = await service.start(
      {
        executable: process.execPath,
        entry: CHILD,
        cwd: this.root,
        env: { ...definedEnvironment(), REVO_LAUNCH_PROCESS_EVENTS: this.eventsPath },
        ...overrides,
      },
      { signal: this.controller.signal, graceMs: 25, killWaitMs: 500 },
    );
    this.port.subscribe((message) => this.deliver(message));
    return this.port;
  }

  managedProcessRequests(): readonly ManagedProcessRequest[] {
    return this.managedProcesses.requests;
  }

  expectedManagedProcessRequest(): ManagedProcessRequest {
    return {
      executable: process.execPath,
      args: [CHILD],
      cwd: this.root,
      env: { ...definedEnvironment(), REVO_LAUNCH_PROCESS_EVENTS: this.eventsPath },
      cancellation: { graceMs: 25, killWaitMs: 500, signal: this.controller.signal },
      detached: true,
      ipc: true,
      stdio: { stderr: 'ignore', stdin: 'ignore', stdout: 'ignore' },
    };
  }

  async booted(): Promise<unknown> {
    return this.messageMatching((message) => record(message) && message.type === 'booted');
  }

  async observed(operationId: string): Promise<unknown> {
    return this.messageMatching(
      (message) =>
        record(message) && message.type === 'committed' && message.operationId === operationId,
    );
  }

  async send(port: ServerLaunchProcessPort, message: ServerHostParentMessage): Promise<void> {
    await port.send(message);
  }

  abort(): void {
    this.controller.abort();
  }

  async completion(port: ServerLaunchProcessPort): Promise<ProcessCompletion> {
    return bounded(port.completion);
  }

  async waitForEvent(message: object): Promise<void> {
    const expected = JSON.stringify(message);
    await eventually(async () => {
      const lines = await readFile(this.eventsPath, 'utf8').catch(() => '');
      if (!lines.split('\n').includes(expected)) {
        throw new Error('Launch process event was not observed yet.');
      }
    });
  }

  async cleanup(): Promise<void> {
    if (this.port) {
      await this.port.stop().catch(() => undefined);
      await bounded(this.port.completion).catch(() => undefined);
    }
    await import('node:fs/promises').then(({ rm }) =>
      rm(this.root, { force: true, recursive: true }),
    );
  }

  private deliver(message: unknown): void {
    this.received.push(message);
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }

  private messageMatching(predicate: (message: unknown) => boolean): Promise<unknown> {
    const already = this.received.find(predicate);
    if (already !== undefined) {
      return Promise.resolve(already);
    }
    return bounded(
      new Promise((resolve) => {
        this.waiters.add({ predicate, resolve });
      }),
    );
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const definedEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

async function eventually(
  assertion: () => Promise<void>,
  deadline = Date.now() + 1_000,
): Promise<void> {
  try {
    await assertion();
  } catch (error) {
    if (Date.now() >= deadline) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    return eventually(assertion, deadline);
  }
}

function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Launch process scenario exceeded one second.')),
      1_000,
    );
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}
