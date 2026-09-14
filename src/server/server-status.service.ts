import { Inject, Injectable } from '@nestjs/common';

import { ControlClientService } from '../processes/control-client.service.js';
import { ControlDiscoveryService } from '../processes/control-discovery.service.js';
import type { ControlLimits, ControlServerStatus } from '../processes/control-endpoint.types.js';
import { DEFAULT_CONTROL_LIMITS } from '../processes/control-endpoint.types.js';
import { ServerOwnershipService } from '../processes/server-ownership.service.js';

export type ServerStatus =
  | { readonly kind: 'missing' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'running'; readonly status: ControlServerStatus }
  | { readonly kind: 'starting' | 'stopping' | 'failed'; readonly status: ControlServerStatus }
  | { readonly kind: 'unknown' };

@Injectable()
export class ServerStatusService {
  constructor(
    @Inject(ControlDiscoveryService)
    private readonly discovery = new ControlDiscoveryService(),
    @Inject(ControlClientService)
    private readonly controls = new ControlClientService(),
    @Inject(ServerOwnershipService)
    private readonly ownership = new ServerOwnershipService(),
  ) {}

  async read(dataDir: string, limits?: ControlLimits): Promise<ServerStatus> {
    const bounded = limits ?? DEFAULT_CONTROL_LIMITS;
    const deadline = Date.now() + bounded.timeoutMs;
    let first: Awaited<ReturnType<ControlDiscoveryService['read']>>;
    try {
      first = await this.discovery.read(dataDir);
      remaining(deadline);
    } catch {
      return { kind: 'unknown' };
    }
    if (first.kind === 'missing') {
      let ownership: Awaited<ReturnType<ServerOwnershipService['inspect']>>;
      try {
        ownership = await this.ownership.inspect(dataDir);
        remaining(deadline);
      } catch {
        return { kind: 'unknown' };
      }
      if (ownership.kind === 'missing' || ownership.kind === 'free') {
        return { kind: 'stopped' };
      }
      return { kind: 'unknown' };
    }
    if (first.kind !== 'found') {
      return { kind: 'unknown' };
    }
    let status: ControlServerStatus;
    try {
      status = await this.controls.requestStatus(first.record, withRemaining(bounded, deadline));
    } catch {
      return { kind: 'unknown' };
    }
    try {
      remaining(deadline);
    } catch {
      return { kind: 'unknown' };
    }
    if (status.phase !== 'running') {
      if (status.phase === 'stopped') {
        return { kind: 'stopped' };
      }
      if (status.phase === 'starting' || status.phase === 'stopping' || status.phase === 'failed') {
        return { kind: status.phase, status };
      }
      return { kind: 'unknown' };
    }
    if (!validListener(status)) {
      return { kind: 'unknown' };
    }
    try {
      remaining(deadline);
      const response = await fetch(
        `http://${formatHost(status.host)}:${String(status.port)}/graphql`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ __typename }' }),
          redirect: 'error',
          signal: AbortSignal.timeout(remaining(deadline)),
        },
      );
      remaining(deadline);
      if (!response.ok) {
        return { kind: 'unknown' };
      }
      const value: unknown = JSON.parse(await readBounded(response, bounded.maxFrameBytes));
      remaining(deadline);
      if (!isReadyGraphql(value)) {
        return { kind: 'unknown' };
      }
      const confirmed = await this.controls.requestStatus(
        first.record,
        withRemaining(bounded, deadline),
      );
      remaining(deadline);
      const current = await this.discovery.read(dataDir);
      remaining(deadline);
      if (
        confirmed.phase !== 'running' ||
        current.kind !== 'found' ||
        current.record.instanceId !== first.record.instanceId
      ) {
        return { kind: 'unknown' };
      }
    } catch {
      return { kind: 'unknown' };
    }
    return { kind: 'running', status };
  }
}

function validListener(status: ControlServerStatus): status is ControlServerStatus & {
  readonly host: string;
  readonly port: number;
} {
  return (
    typeof status.host === 'string' &&
    typeof status.port === 'number' &&
    Number.isInteger(status.port) &&
    status.port > 0
  );
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function isReadyGraphql(value: unknown): boolean {
  if (!record(value) || !exact(value, ['data']) || !record(value.data)) {
    return false;
  }
  return exact(value.data, ['__typename']) && value.data['__typename'] === 'Query';
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const remaining = (deadline: number) => {
  const milliseconds = deadline - Date.now();
  if (milliseconds < 1) {
    throw new Error('status deadline exceeded');
  }
  return milliseconds;
};
const withRemaining = (limits: ControlLimits, deadline: number): ControlLimits => ({
  ...limits,
  timeoutMs: remaining(deadline),
});

async function readBounded(response: Response, maximum: number): Promise<string> {
  if (!response.body) {
    throw new Error('missing response');
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maximum) {
        throw new Error('oversized response');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } finally {
    await response.body.cancel().catch(() => undefined);
  }
}
