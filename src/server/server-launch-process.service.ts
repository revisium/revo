import process from 'node:process';

import { ManagedProcessError } from '../processes/managed-process-error.js';
import { ManagedProcessService } from '../processes/managed-process.service.js';
import type {
  ManagedProcessRequest,
  OwnedProcess,
  ProcessCompletion,
  ProcessStdio,
  StopProcessRequest,
} from '../processes/managed-process.types.js';
import {
  ServerLogError,
  openServerLog,
  type OpenedServerLog,
  type ServerLogLocation,
} from '../server-logs/server-log.js';
import type { ServerHostParentMessage } from './server-host-protocol.js';
import type { ServerLaunchProcessPort } from './server-launch-attempt.js';

export interface ServerLaunchBinding {
  readonly cwd: string;
  readonly entry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executable: string;
  /** Where the detached server, and the Core it hosts, append their output. */
  readonly log?: ServerLogLocation;
}

export interface ServerLaunchStartOptions {
  readonly graceMs: number;
  readonly killWaitMs: number;
  readonly signal: AbortSignal;
}

export class ServerLaunchProcessService {
  constructor(
    private readonly processes: ManagedProcessService = new ManagedProcessService(),
    private readonly warn: (message: string) => void = writeWarning,
  ) {}

  async start(
    binding: ServerLaunchBinding,
    options: ServerLaunchStartOptions,
  ): Promise<ServerLaunchProcessPort> {
    const stopRequest: StopProcessRequest = {
      graceMs: options.graceMs,
      killWaitMs: options.killWaitMs,
    };
    const log = binding.log ? await this.openLog(binding.log) : undefined;
    const output: ProcessStdio = log?.handle.fd ?? 'ignore';
    let handle: OwnedProcess;
    try {
      handle = await this.processes.start({
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
        stdio: { stderr: output, stdin: 'ignore', stdout: output },
      } satisfies ManagedProcessRequest);
    } finally {
      // The detached child owns its duplicated descriptor; the launcher keeps none.
      await log?.handle.close().catch(() => undefined);
    }
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

  /** Logging is diagnostics: an unusable log never prevents the server from starting. */
  private async openLog(location: ServerLogLocation): Promise<OpenedServerLog | undefined> {
    try {
      return await openServerLog(location);
    } catch (error) {
      const path = error instanceof ServerLogError ? error.path : 'the server log';
      this.warn(`Warning: server output is not logged; ${path} is unavailable.`);
      return undefined;
    }
  }
}

function writeWarning(message: string): void {
  process.stderr.write(`${message}\n`);
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
