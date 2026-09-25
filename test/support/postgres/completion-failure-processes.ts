import { ManagedProcessService } from '@revisium/revo/processes';
import type {
  ManagedProcessRequest,
  OwnedProcess,
  ProcessCompletion,
  StopProcessRequest,
} from '@revisium/revo/processes';

export class CompletionFailurePostgresProcesses extends ManagedProcessService {
  readonly injectedCompletionFailure = new Error('injected PostgreSQL completion failure');
  postgresStarts = 0;
  postgresStops = 0;
  private closing = false;
  private postgres: OwnedProcess | undefined;
  private readonly physicalProcesses = new WeakMap<OwnedProcess, OwnedProcess>();
  private readonly physicalCompletions = new WeakMap<OwnedProcess, Promise<ProcessCompletion>>();
  private readonly children = new Set<OwnedProcess>();
  private readonly pendingStarts = new Set<Promise<OwnedProcess>>();

  override async start(request: ManagedProcessRequest): Promise<OwnedProcess> {
    if (this.closing) {
      throw new Error('Completion failure process fixture is closing');
    }
    const starting = super.start(request);
    this.pendingStarts.add(starting);
    let physical: OwnedProcess;
    try {
      physical = await starting;
    } finally {
      this.pendingStarts.delete(starting);
    }
    let observed = physical;
    if (request.args[0] === '-D') {
      const physicalCompletion = physical.completion;
      const completion = physicalCompletion.then(() => {
        throw this.injectedCompletionFailure;
      });
      observed = new Proxy(physical, {
        get(target, property) {
          return property === 'completion' ? completion : Reflect.get(target, property, target);
        },
      });
      this.postgres = observed;
      this.postgresStarts += 1;
      this.physicalCompletions.set(observed, physicalCompletion);
      this.physicalProcesses.set(observed, physical);
    } else {
      this.physicalCompletions.set(observed, observed.completion);
      this.physicalProcesses.set(observed, observed);
    }
    this.children.add(observed);
    void observed.completion.then(
      () => undefined,
      () => undefined,
    );
    return observed;
  }

  override stop(handle: OwnedProcess, request: StopProcessRequest): Promise<void> {
    if (handle === this.postgres) {
      this.postgresStops += 1;
    }
    return super.stop(this.physicalProcess(handle), request);
  }

  async stopPostgresForFixture(): Promise<void> {
    const child = this.postgres;
    if (!child) {
      throw new Error('No owned PostgreSQL process is available for fixture stop');
    }
    const physical = this.physicalProcess(child);
    await super.stop(physical, {
      graceMs: 20_000,
      killWaitMs: 5000,
      escalationSignal: 'SIGINT',
    });
    await this.physicalCompletion(child);
    await this.waitForPostExitHook(child);
  }

  async waitForInjectedCompletionFailure(): Promise<void> {
    const child = this.postgres;
    if (!child) {
      throw new Error('No owned PostgreSQL process is available for completion observation');
    }
    await child.completion.then(
      () => {
        throw new Error('Expected injected PostgreSQL completion failure');
      },
      (error: unknown) => {
        if (error !== this.injectedCompletionFailure) {
          throw error;
        }
      },
    );
  }

  async drain(): Promise<void> {
    this.closing = true;
    const starts = await Promise.allSettled([...this.pendingStarts]);
    const physical = await Promise.allSettled(
      [...this.children].map((child) => this.physicalCompletion(child)),
    );
    const hooks = await Promise.allSettled(
      [...this.children].map((child) => this.waitForPostExitHook(child)),
    );
    const failures = [
      ...starts.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
      ...physical.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
      ...hooks.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
    ];
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Completion failure process fixture did not drain');
    }
  }

  private physicalProcess(child: OwnedProcess): OwnedProcess {
    return this.physicalProcesses.get(child) ?? child;
  }

  private physicalCompletion(child: OwnedProcess): Promise<ProcessCompletion> {
    return this.physicalCompletions.get(child) ?? child.completion;
  }

  private async waitForPostExitHook(child: OwnedProcess): Promise<void> {
    try {
      await child.completion;
    } catch (error) {
      if (error !== this.injectedCompletionFailure) {
        throw error;
      }
    }
  }
}
