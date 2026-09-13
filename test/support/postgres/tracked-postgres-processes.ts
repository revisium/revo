import { ManagedProcessService } from '../../../src/processes/managed-process.service.js';
import type {
  ManagedProcessRequest,
  OwnedProcess,
  ProcessCompletion,
} from '../../../src/processes/managed-process.types.js';

export interface TrackedPostgresProcessesOptions {
  readonly failFirstPostgresStop?: boolean;
}

export class TrackedPostgresProcesses extends ManagedProcessService {
  postgresStarts = 0;
  completedPostgres = 0;
  completion: Promise<ProcessCompletion> | undefined;
  private postgres: OwnedProcess | undefined;
  private stopFailed = false;

  constructor(private readonly options: TrackedPostgresProcessesOptions = {}) {
    super();
  }

  override async start(request: ManagedProcessRequest) {
    const postgres = request.args[0] === '-D';
    const process = await super.start(request);
    if (postgres) {
      this.postgresStarts += 1;
      this.postgres = process;
      this.completion = process.completion;
      void process.completion.then(() => {
        this.completedPostgres += 1;
      });
    }
    return process;
  }

  override stop(handle: OwnedProcess, request: { graceMs: number; killWaitMs: number }) {
    if (handle === this.postgres && this.options.failFirstPostgresStop && !this.stopFailed) {
      this.stopFailed = true;
      return Promise.reject(new Error('injected owned stop failure'));
    }
    return super.stop(handle, request);
  }

  async release() {
    if (!this.postgres) {
      return;
    }
    await super.stop(this.postgres, { graceMs: 1000, killWaitMs: 5000 });
    await this.postgres.completion;
  }
}
