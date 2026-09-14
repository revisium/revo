import {
  createRevoCoreRuntime,
  type RevoCoreRuntime,
  type RevoCoreRuntimeOptions,
} from '@revisium/revo-core/runtime';

import { configureAdminSpa } from '../admin/admin-spa.js';
import type { CoreHostStartMessage } from './core-child-protocol.js';

export interface StartedCoreRuntime {
  readonly runtime: RevoCoreRuntime;
  readonly listening: { readonly host: string; readonly port: number; readonly url: string };
}

export class CoreRuntimeService {
  async start(
    request: CoreHostStartMessage,
    signal: AbortSignal,
    onStage: NonNullable<RevoCoreRuntimeOptions['onStage']>,
  ): Promise<StartedCoreRuntime> {
    const runtime = await this.createRuntime({
      databaseUrl: request.databaseUrl,
      temporaryWorkingDirectoryRoot: request.temporaryWorkingDirectoryRoot,
      agentWorkspaceDirectory: request.agentWorkspaceDirectory,
      logger: false,
      onStage,
    });
    if (signal.aborted) {
      await runtime.close();
      throw new CoreRuntimeStoppedError();
    }
    try {
      await configureAdminSpa(runtime);
      await runtime.prepareDatabase({ signal });
      if (signal.aborted) {
        throw new CoreRuntimeStoppedError();
      }
      const listening = await runtime.listen({ host: request.host, port: request.port });
      if (signal.aborted) {
        throw new CoreRuntimeStoppedError();
      }
      return { runtime, listening };
    } catch (error) {
      const stopped = signal.aborted;
      await runtime.close();
      if (stopped) {
        throw new CoreRuntimeStoppedError();
      }
      throw error;
    }
  }

  protected createRuntime(options: RevoCoreRuntimeOptions): Promise<RevoCoreRuntime> {
    return createRevoCoreRuntime(options);
  }
}

export class CoreRuntimeStoppedError extends Error {
  constructor() {
    super('Core runtime startup was stopped');
    this.name = 'CoreRuntimeStoppedError';
  }
}
