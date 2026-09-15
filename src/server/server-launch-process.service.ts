import { ManagedProcessError } from '../processes/managed-process-error.js';
import { ManagedProcessService } from '../processes/managed-process.service.js';
import type {
  ManagedProcessRequest,
  OwnedProcess,
  ProcessCompletion,
  StopProcessRequest,
} from '../processes/managed-process.types.js';
import type { ServerHostParentMessage } from './server-host-protocol.js';
import type { ServerLaunchProcessPort } from './server-launch-attempt.js';

export interface ServerLaunchBinding {
  readonly cwd: string;
  readonly entry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executable: string;
}

export interface ServerLaunchStartOptions {
  readonly graceMs: number;
  readonly killWaitMs: number;
  readonly signal: AbortSignal;
}

export class ServerLaunchProcessService {
  constructor(private readonly processes: ManagedProcessService = new ManagedProcessService()) {}

  async start(
    binding: ServerLaunchBinding,
    options: ServerLaunchStartOptions,
  ): Promise<ServerLaunchProcessPort> {
    const stopRequest: StopProcessRequest = {
      graceMs: options.graceMs,
      killWaitMs: options.killWaitMs,
    };
    const handle = await this.processes.start({
      executable: binding.executable,
      args: [binding.entry],
      cwd: binding.cwd,
      env: binding.env,
      cancellation: {
        graceMs: options.graceMs,
        killWaitMs: options.killWaitMs,
        signal: options.signal,
      },
      detached: true,
      ipc: true,
      stdio: { stderr: 'ignore', stdin: 'ignore', stdout: 'ignore' },
    } satisfies ManagedProcessRequest);
    try {
      return new ManagedServerLaunchProcess(this.processes, handle, stopRequest);
    } catch (error) {
      try {
        await this.processes.stop(handle, stopRequest);
        await handle.completion.catch(() => undefined);
      } catch {
        // Stop itself failed: the process may still be running, so do not wait on completion.
      }
      throw error;
    }
  }
}

type DetachedIpcProcess = OwnedProcess &
  Required<Pick<OwnedProcess, 'abandonUncertain' | 'detachCommitted' | 'send' | 'subscribe'>>;

function assertDetachedIpcCapabilities(handle: OwnedProcess): asserts handle is DetachedIpcProcess {
  if (
    handle.send === undefined ||
    handle.subscribe === undefined ||
    handle.detachCommitted === undefined ||
    handle.abandonUncertain === undefined
  ) {
    throw new ManagedProcessError(
      'revo.process.invalid',
      'Managed launch process is missing a detached IPC capability.',
    );
  }
}

class ManagedServerLaunchProcess implements ServerLaunchProcessPort {
  readonly completion: Promise<ProcessCompletion>;
  private readonly handle: DetachedIpcProcess;

  constructor(
    private readonly processes: ManagedProcessService,
    handle: OwnedProcess,
    private readonly stopRequest: StopProcessRequest,
  ) {
    assertDetachedIpcCapabilities(handle);
    this.handle = handle;
    this.completion = handle.completion;
  }

  send(message: ServerHostParentMessage): Promise<void> {
    return this.handle.send(message);
  }

  subscribe(listener: (message: unknown) => void): () => void {
    return this.handle.subscribe(listener);
  }

  stop(): Promise<void> {
    return this.processes.stop(this.handle, this.stopRequest);
  }

  detachCommitted(): Promise<void> {
    return this.handle.detachCommitted();
  }

  abandonUncertain(): Promise<void> {
    return this.handle.abandonUncertain();
  }
}
