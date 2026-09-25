import { writeFile } from 'node:fs/promises';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { ManagedProcessService } from '../../../src/processes/managed-process.service.js';
import type {
  ManagedProcessRequest,
  OwnedProcess,
  ProcessCompletion,
  StopProcessRequest,
} from '../../../src/processes/managed-process.types.js';
import { PostgresProcessDiagnosticCollector } from './process-diagnostic-collector.js';

export interface TrackedPostgresProcessesOptions {
  readonly failFirstPostgresStop?: boolean;
  readonly failPostgresCompletionAfterExit?: boolean;
  readonly postmasterPidAfterExit?: 'file' | 'symlink';
  readonly owner?: string;
  readonly diagnostics?: PostgresProcessDiagnosticCollector;
}

interface StopPolicy {
  readonly graceMs: number;
  readonly killWaitMs: number;
  readonly escalationSignal?: 'SIGINT' | 'SIGKILL';
}

export class TrackedPostgresProcesses extends ManagedProcessService {
  processStarts = 0;
  postgresStarts = 0;
  completedPostgres = 0;
  readonly postgresCancellationPolicies: StopPolicy[] = [];
  readonly postgresStopPolicies: StopPolicy[] = [];
  readonly injectedCompletionFailure = new Error('injected PostgreSQL completion failure');
  completion: Promise<ProcessCompletion> | undefined;
  private postgres: OwnedProcess | undefined;
  private stopFailed = false;
  private closingForCleanup = false;
  private readonly pendingStarts = new Set<Promise<OwnedProcess>>();
  private readonly children = new Set<OwnedProcess>();
  private readonly completionFailures = new Set<unknown>();
  private readonly physicalCompletions = new WeakMap<OwnedProcess, Promise<ProcessCompletion>>();
  private readonly physicalProcesses = new WeakMap<OwnedProcess, OwnedProcess>();
  private resolvePostgresStopRequested!: () => void;
  readonly postgresStopRequested = new Promise<void>((resolve) => {
    this.resolvePostgresStopRequested = resolve;
  });

  constructor(private readonly options: TrackedPostgresProcessesOptions = {}) {
    super();
  }

  override async start(request: ManagedProcessRequest) {
    if (this.closingForCleanup) {
      throw new Error('Tracked PostgreSQL process fixture is closing');
    }
    const postgres = request.args[0] === '-D';
    const diagnosticId = this.options.diagnostics?.startRequested({
      owner: this.options.owner ?? 'unassigned',
      request,
    });
    this.processStarts += 1;
    let process: OwnedProcess;
    const starting = super.start(request);
    this.pendingStarts.add(starting);
    try {
      process = await starting;
    } catch (error) {
      if (diagnosticId !== undefined) {
        this.options.diagnostics?.startRejected(diagnosticId, error);
      }
      throw error;
    } finally {
      this.pendingStarts.delete(starting);
    }
    if (
      postgres &&
      (this.options.postmasterPidAfterExit || this.options.failPostgresCompletionAfterExit)
    ) {
      const physicalProcess = process;
      const originalCompletion = process.completion;
      const pidPath = join(request.args[1] ?? '', 'postmaster.pid');
      const completion = originalCompletion.then(async (result) => {
        if (this.options.postmasterPidAfterExit) {
          const fixtureTarget = `${pidPath}.fixture-target`;
          await writeFile(fixtureTarget, 'fixture-postmaster-marker-target\n', {
            flag: 'w',
            mode: 0o600,
          });
          if (this.options.postmasterPidAfterExit === 'symlink') {
            await symlink(fixtureTarget, pidPath);
          } else {
            await writeFile(pidPath, 'fixture-retained-postmaster-marker\n', {
              flag: 'w',
              mode: 0o600,
            });
          }
        }
        if (this.options.failPostgresCompletionAfterExit) {
          throw this.injectedCompletionFailure;
        }
        return result;
      });
      process = new Proxy(process, {
        get(target, property) {
          return property === 'completion' ? completion : Reflect.get(target, property, target);
        },
      });
      this.physicalCompletions.set(process, originalCompletion);
      this.physicalProcesses.set(process, physicalProcess);
    } else if (postgres) {
      this.physicalCompletions.set(process, process.completion);
      this.physicalProcesses.set(process, process);
    }
    this.children.add(process);
    void process.completion.then(
      () => undefined,
      (error: unknown) => this.completionFailures.add(error),
    );
    if (diagnosticId !== undefined) {
      this.processDiagnosticIds.set(process, diagnosticId);
      this.options.diagnostics?.processStarted(diagnosticId, process);
    }
    if (postgres) {
      this.postgresStarts += 1;
      this.postgres = process;
      this.completion = process.completion;
      if (request.cancellation) {
        this.postgresCancellationPolicies.push({
          graceMs: request.cancellation.graceMs,
          killWaitMs: request.cancellation.killWaitMs,
        });
      }
      void process.completion.then(
        () => {
          this.completedPostgres += 1;
        },
        () => undefined,
      );
    }
    return process;
  }

  override async stop(handle: OwnedProcess, request: StopProcessRequest) {
    const diagnosticId = this.processDiagnosticIds.get(handle);
    this.options.diagnostics?.stopRequested(diagnosticId, request);
    if (handle === this.postgres) {
      this.postgresStopPolicies.push({
        graceMs: request.graceMs,
        killWaitMs: request.killWaitMs,
        ...(request.escalationSignal === undefined
          ? {}
          : { escalationSignal: request.escalationSignal }),
      });
      this.resolvePostgresStopRequested();
    }
    if (handle === this.postgres && this.options.failFirstPostgresStop && !this.stopFailed) {
      this.stopFailed = true;
      const error = new Error('injected owned stop failure');
      this.options.diagnostics?.stopRejected(diagnosticId, error);
      throw error;
    }
    try {
      await super.stop(handle, request);
      this.options.diagnostics?.stopResolved(diagnosticId);
    } catch (error) {
      this.options.diagnostics?.stopRejected(diagnosticId, error);
      throw error;
    }
  }

  async release() {
    const child = this.postgres;
    if (!child) {
      return;
    }
    await super.stop(this.physicalProcess(child), { graceMs: 20_000, killWaitMs: 5000 });
    await this.physicalCompletion(child);
    await this.waitForPostExitHook(child);
  }

  async stopPostgresForFixture() {
    const child = this.postgres;
    if (!child) {
      throw new Error('No owned PostgreSQL process is available for fixture stop');
    }
    await super.stop(this.physicalProcess(child), {
      graceMs: 20_000,
      killWaitMs: 5000,
      escalationSignal: 'SIGINT',
    });
    await this.physicalCompletion(child);
    await this.waitForPostExitHook(child);
  }

  async waitForInjectedCompletionFailure() {
    if (!this.postgres) {
      throw new Error('No owned PostgreSQL process is available for completion observation');
    }
    await this.postgres.completion.then(
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

  get physicalPostgresCompletion() {
    return this.postgres ? this.physicalCompletion(this.postgres) : undefined;
  }

  closeAdmission() {
    this.closingForCleanup = true;
  }

  async drain() {
    this.closeAdmission();
    const pendingStarts = await Promise.allSettled([...this.pendingStarts]);
    const failures = pendingStarts.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    const completions = await Promise.allSettled(
      [...this.children].map((child) => this.physicalCompletion(child)),
    );
    const postExitHooks = await Promise.allSettled(
      [...this.children].map((child) => this.waitForPostExitHook(child)),
    );
    failures.push(
      ...completions.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
      ...postExitHooks.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
      ...[...this.completionFailures].filter(
        (failure) => failure !== this.injectedCompletionFailure,
      ),
    );
    if (failures.length > 0) {
      throw new AggregateError(
        [...new Set(failures)],
        'Tracked PostgreSQL processes did not drain',
      );
    }
  }

  private readonly processDiagnosticIds = new WeakMap<OwnedProcess, number>();

  private physicalCompletion(child: OwnedProcess) {
    return this.physicalCompletions.get(child) ?? child.completion;
  }

  private physicalProcess(child: OwnedProcess) {
    return this.physicalProcesses.get(child) ?? child;
  }

  private async waitForPostExitHook(child: OwnedProcess) {
    try {
      await child.completion;
    } catch (error) {
      if (
        !this.options.failPostgresCompletionAfterExit ||
        error !== this.injectedCompletionFailure
      ) {
        throw error;
      }
    }
  }
}
