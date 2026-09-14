import { Inject, Injectable } from '@nestjs/common';

import { ControlClientService } from '../processes/control-client.service.js';
import { ControlDiscoveryService } from '../processes/control-discovery.service.js';
import type { ControlLimits } from '../processes/control-endpoint.types.js';

export type ServerStopResult =
  | { readonly kind: 'completed' }
  | { readonly kind: 'unconfirmed'; readonly ownership?: 'retained' | 'unconfirmed' };

@Injectable()
export class ServerStopService {
  constructor(
    @Inject(ControlDiscoveryService)
    private readonly discovery = new ControlDiscoveryService(),
    @Inject(ControlClientService)
    private readonly controls = new ControlClientService(),
  ) {}

  async stop(
    dataDir: string,
    completionTimeoutMs: number,
    limits?: ControlLimits,
  ): Promise<ServerStopResult> {
    const discovered = await this.discovery.read(dataDir);
    if (discovered.kind !== 'found') {
      return { kind: 'unconfirmed' };
    }
    try {
      const result = await this.controls.requestStopAndWait(
        discovered.record,
        completionTimeoutMs,
        limits,
      );
      return result.kind === 'completed'
        ? result
        : { kind: 'unconfirmed', ownership: result.ownership };
    } catch {
      return { kind: 'unconfirmed' };
    }
  }
}
