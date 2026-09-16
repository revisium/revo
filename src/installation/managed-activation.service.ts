import { Inject, Injectable } from '@nestjs/common';

import { ConfigurationResolver } from '../configuration/configuration-resolver.js';
import type { ConfigurationInput } from '../configuration/configuration.types.js';
import { ServerOwnershipService } from '../processes/server-ownership.service.js';
import { acquireActivationOwnership } from './activation-ownership.js';
import {
  activatePreparedInstallation,
  preparedActivationGenerationId,
  readActivation,
  type ActivationCandidate,
  type ActivationOutcome,
} from './activation-store.js';

export type ManagedActivationOutcome =
  | ActivationOutcome
  | { readonly status: 'server-busy' | 'unavailable' };

@Injectable()
export class ManagedActivationService {
  constructor(
    @Inject(ConfigurationResolver) private readonly configuration = new ConfigurationResolver(),
    @Inject(ServerOwnershipService) private readonly server = new ServerOwnershipService(),
  ) {}

  async activate({
    channelRoot,
    candidate,
    configuration,
    signal,
  }: {
    readonly channelRoot: string;
    readonly candidate: ActivationCandidate;
    readonly configuration: ConfigurationInput;
    readonly signal?: AbortSignal;
  }): Promise<ManagedActivationOutcome> {
    if (signal?.aborted) {
      return { status: 'cancelled' };
    }
    const resolved = await this.configuration.resolve(configuration);
    if (resolved.channel !== candidate.plan.release.channel) {
      return { status: 'unavailable' };
    }
    const ownership = await acquireActivationOwnership({
      channelRoot,
      channel: resolved.channel,
      ...(signal === undefined ? {} : { signal }),
    });
    if (ownership.status !== 'held') {
      return ownership.status === 'busy'
        ? { status: 'busy' }
        : ownership.status === 'cancelled'
          ? { status: 'cancelled' }
          : { status: 'unavailable' };
    }
    const activationLease = ownership.lease;
    let serverLease: Awaited<ReturnType<ServerOwnershipService['acquire']>> | undefined;
    try {
      const current = await readActivation(channelRoot);
      const generation = await preparedActivationGenerationId({
        channelRoot,
        candidate,
        lease: activationLease,
        ...(signal === undefined ? {} : { signal }),
      });
      if (
        typeof generation === 'string' &&
        current.status === 'valid' &&
        current.record.generationId === generation
      ) {
        return { status: 'unchanged', generationId: generation };
      }
      if (typeof generation !== 'string') {
        return generation;
      }
      if (signal?.aborted) {
        return { status: 'cancelled' };
      }
      serverLease = await this.server.acquire(resolved.layout.dataDir);
      if (serverLease.kind !== 'held') {
        return { status: 'server-busy' };
      }
      return await activatePreparedInstallation({
        channelRoot,
        candidate,
        expectedCurrent: current,
        lease: activationLease,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      return { status: 'unavailable' };
    } finally {
      if (serverLease?.kind === 'held') {
        await serverLease.release().catch(() => undefined);
      }
      await activationLease.release().catch(() => undefined);
    }
  }
}
