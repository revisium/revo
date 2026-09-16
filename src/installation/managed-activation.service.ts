import { Inject, Injectable } from '@nestjs/common';

import { ConfigurationResolver } from '../configuration/configuration-resolver.js';
import type { ConfigurationInput } from '../configuration/configuration.types.js';
import { ServerOwnershipService } from '../processes/server-ownership.service.js';
import { acquireActivationOwnership, type HeldActivationLease } from './activation-ownership.js';
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
    private readonly acquireOwnership: typeof acquireActivationOwnership = acquireActivationOwnership,
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
    const ownership = await this.acquireOwnership({
      channelRoot,
      channel: resolved.channel,
      ...(signal === undefined ? {} : { signal }),
    });
    if (ownership.status !== 'held') {
      return this.admissionOutcome(ownership.status);
    }
    const activationLease = ownership.lease;
    let serverLease: Awaited<ReturnType<ServerOwnershipService['acquire']>> | undefined;
    const result = await this.performActivation({
      channelRoot,
      candidate,
      dataDir: resolved.layout.dataDir,
      activationLease,
      ...(signal === undefined ? {} : { signal }),
    });
    serverLease = result.serverLease;
    let cleanupFailed = result.cleanupFailed;
    if (serverLease?.kind === 'held') {
      await serverLease.release().catch(() => {
        cleanupFailed = true;
      });
    }
    const activationRelease = await activationLease.release().then(
      () => true,
      () => false,
    );
    cleanupFailed ||= !activationRelease;
    return cleanupFailed ? { status: 'outcome-unknown' } : result.outcome;
  }

  private admissionOutcome(status: 'busy' | 'cancelled' | 'unavailable'): ManagedActivationOutcome {
    if (status === 'busy') {
      return { status: 'busy' };
    }
    if (status === 'cancelled') {
      return { status: 'cancelled' };
    }
    return { status: 'unavailable' };
  }

  private async performActivation(input: {
    readonly channelRoot: string;
    readonly candidate: ActivationCandidate;
    readonly signal?: AbortSignal;
    readonly dataDir: string;
    readonly activationLease: HeldActivationLease;
  }): Promise<{
    readonly outcome: ManagedActivationOutcome;
    readonly serverLease?: Awaited<ReturnType<ServerOwnershipService['acquire']>>;
    readonly cleanupFailed: boolean;
  }> {
    let serverLease: Awaited<ReturnType<ServerOwnershipService['acquire']>> | undefined;
    try {
      const current = await readActivation(input.channelRoot);
      const generation = await preparedActivationGenerationId({
        channelRoot: input.channelRoot,
        candidate: input.candidate,
        lease: input.activationLease,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (
        typeof generation === 'string' &&
        current.status === 'valid' &&
        current.record.generationId === generation
      ) {
        return { outcome: { status: 'unchanged', generationId: generation }, cleanupFailed: false };
      }
      if (typeof generation !== 'string') {
        return { outcome: generation, cleanupFailed: false };
      }
      if (input.signal?.aborted) {
        return { outcome: { status: 'cancelled' }, cleanupFailed: false };
      }
      serverLease = await this.server.acquire(input.dataDir);
      if (serverLease.kind !== 'held') {
        return { outcome: { status: 'server-busy' }, serverLease, cleanupFailed: false };
      }
      const outcome = await activatePreparedInstallation({
        channelRoot: input.channelRoot,
        candidate: input.candidate,
        expectedCurrent: current,
        lease: input.activationLease,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return { outcome, serverLease, cleanupFailed: false };
    } catch {
      return {
        outcome: { status: 'unavailable' },
        ...(serverLease === undefined ? {} : { serverLease }),
        cleanupFailed: false,
      };
    }
  }
}
