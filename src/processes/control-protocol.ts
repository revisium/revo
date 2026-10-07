import { isAbsolute } from 'node:path';

import { isRecord } from '../record.js';
import { isTimerTimeout } from '../timers.js';
import type { ControlLimits, ControlRecord } from './control-endpoint.types.js';
import { parseIdentity } from './process-identity.parser.js';

const HEX32 = /^[0-9a-f]{32}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

type ControlAction = 'probe' | 'status' | 'stop' | 'stop-and-wait';
interface ControlRequest {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly token: string;
  readonly action: ControlAction;
}

export function parseControlRecord(value: unknown): ControlRecord | undefined {
  if (
    !isRecord(value) ||
    !exact(value, [
      'schemaVersion',
      'instanceId',
      'token',
      'version',
      'channel',
      'canonicalDataDir',
      'endpoint',
      'process',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.instanceId !== 'string' ||
    !HEX32.test(value.instanceId) ||
    typeof value.token !== 'string' ||
    !HEX64.test(value.token) ||
    !text(value.version) ||
    !text(value.channel) ||
    !text(value.canonicalDataDir) ||
    !isAbsolute(value.canonicalDataDir) ||
    value.canonicalDataDir.includes('\0') ||
    !text(value.endpoint) ||
    !validEndpointPath(value.endpoint)
  ) {
    return undefined;
  }
  const process = parseIdentity(value.process);
  return process
    ? {
        schemaVersion: 1,
        instanceId: value.instanceId,
        token: value.token,
        version: value.version,
        channel: value.channel,
        canonicalDataDir: value.canonicalDataDir,
        endpoint: value.endpoint,
        process,
      }
    : undefined;
}

/** Usable `sun_path` bytes: macOS reserves 104 including NUL, Linux 108. */
export function controlEndpointByteLimit(): number {
  return process.platform === 'darwin' ? 103 : 107;
}

function validEndpointPath(endpoint: string): boolean {
  return (
    isAbsolute(endpoint) &&
    !endpoint.includes('\0') &&
    Buffer.byteLength(endpoint) <= controlEndpointByteLimit()
  );
}

export function validInstanceId(value: unknown): value is string {
  return typeof value === 'string' && HEX32.test(value);
}

export function parseControlRequest(value: unknown): ControlRequest | undefined {
  if (!isRecord(value) || !exact(value, ['schemaVersion', 'instanceId', 'token', 'action'])) {
    return undefined;
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.instanceId !== 'string' ||
    !HEX32.test(value.instanceId) ||
    typeof value.token !== 'string' ||
    !HEX64.test(value.token) ||
    (value.action !== 'probe' &&
      value.action !== 'status' &&
      value.action !== 'stop' &&
      value.action !== 'stop-and-wait')
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    instanceId: value.instanceId,
    token: value.token,
    action: value.action,
  };
}

export function validateLimits(limits: ControlLimits): void {
  if (
    !isTimerTimeout(limits.timeoutMs) ||
    !Number.isSafeInteger(limits.maxFrameBytes) ||
    limits.maxFrameBytes < 2
  ) {
    throw new ControlTransportError('Invalid control transport limits');
  }
}

export class ControlTransportError extends Error {
  readonly code = 'CONTROL_TRANSPORT_ERROR';
  constructor(message = 'Control transport operation failed') {
    super(message);
    this.name = 'ControlTransportError';
  }
}
