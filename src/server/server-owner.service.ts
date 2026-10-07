import { Inject, Injectable } from '@nestjs/common';

import { CoreHostProcessService } from '../core-host/core-host-process.service.js';
import type { PublishedControl } from '../processes/control-discovery.types.js';
import type { ControlStopCompletion } from '../processes/control-endpoint.types.js';
import { PublishedControlService } from '../processes/published-control.service.js';
import { RevoConsoleLogger } from '../server-logs/revo-console-logger.js';
import { ServerOwnerError } from './server-owner-error.js';
import { ServerOwnerResource } from './server-owner.resource.js';
import type { OpenServerOwnerRequest } from './server-owner.types.js';

export { ServerOwnerError } from './server-owner-error.js';
export { ServerOwnerResource } from './server-owner.resource.js';
export type {
  OpenServerOwnerRequest,
  ServerOwnerConfiguration,
  ServerOwnerOutcome,
} from './server-owner.types.js';

const logger = new RevoConsoleLogger('ServerOwner');

type OpenServerOwnerResult = { readonly kind: 'busy' } | ServerOwnerResource;

@Injectable()
export class ServerOwnerService {
  constructor(
    @Inject(PublishedControlService)
    private readonly controls = new PublishedControlService(),
    @Inject(CoreHostProcessService)
    private readonly coreHosts = new CoreHostProcessService(),
  ) {}

  async open(request: OpenServerOwnerRequest): Promise<OpenServerOwnerResult> {
    let owner: ServerOwnerResource | undefined;
    let resolveOwner!: (resource: ServerOwnerResource) => void;
    let rejectOwner!: (error: Error) => void;
    let earlyStop: Promise<ControlStopCompletion> | undefined;
    const ownerAssigned = new Promise<ServerOwnerResource>((resolve, reject) => {
      resolveOwner = resolve;
      rejectOwner = reject;
    });
    void ownerAssigned.catch(() => undefined);
    let held: PublishedControl;
    try {
      held = await this.controls.open({
        dataDir: request.configuration.dataDir,
        logDir: request.configuration.logDir,
        runtimeDir: request.configuration.runtimeDir,
        version: request.configuration.version,
        channel: request.configuration.channel,
        ...(request.configuration.databaseUrl !== undefined
          ? { databaseUrl: request.configuration.databaseUrl }
          : {}),
        startupProgress: { operationId: request.operationId, now: request.now ?? Date.now },
        onStop: () => {
          const operation = (async () => (owner ?? (await ownerAssigned)).stopFromControl())();
          if (!owner) {
            earlyStop = operation;
          }
          return operation;
        },
        onStatus: () => owner?.status() ?? { phase: 'starting', operationId: request.operationId },
      });
    } catch (error) {
      logger.failure('Server could not open its data directory and control endpoint', error);
      rejectOwner(new ServerOwnerError('revo.server-owner.stop'));
      throw error;
    }
    if (held.kind === 'busy') {
      rejectOwner(new ServerOwnerError('revo.server-owner.stop'));
      return held;
    }
    owner = new ServerOwnerResource(request, held, this.coreHosts);
    resolveOwner(owner);
    await earlyStop;
    return owner;
  }
}
