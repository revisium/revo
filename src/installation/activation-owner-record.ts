import { parseIdentity } from '../processes/process-identity.parser.js';
import type { ProcessIdentity } from '../processes/process-identity.types.js';

export const ACTIVATION_OWNER_SCHEMA = 'revo-activation-owner/v1' as const;
export const ACTIVATION_OWNER_LIMIT = 4096;

export interface ActivationOwnerRecord {
  readonly schemaVersion: typeof ACTIVATION_OWNER_SCHEMA;
  readonly channel: 'stable' | 'alpha';
  readonly token: string;
  readonly process: ProcessIdentity;
  readonly lock: { readonly dev: string; readonly ino: string };
}

const HEX64 = /^[a-f0-9]{64}$/u;
const DECIMAL = /^(?:0|[1-9]\d*)$/u;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function parseActivationOwnerRecord(value: unknown): ActivationOwnerRecord | undefined {
  if (
    !record(value) ||
    !exact(value, ['schemaVersion', 'channel', 'token', 'process', 'lock']) ||
    value.schemaVersion !== ACTIVATION_OWNER_SCHEMA ||
    (value.channel !== 'stable' && value.channel !== 'alpha') ||
    typeof value.token !== 'string' ||
    !HEX64.test(value.token) ||
    !record(value.lock) ||
    !exact(value.lock, ['dev', 'ino']) ||
    typeof value.lock.dev !== 'string' ||
    !DECIMAL.test(value.lock.dev) ||
    typeof value.lock.ino !== 'string' ||
    !DECIMAL.test(value.lock.ino)
  ) {
    return undefined;
  }
  const process = parseIdentity(value.process);
  return process
    ? {
        schemaVersion: ACTIVATION_OWNER_SCHEMA,
        channel: value.channel,
        token: value.token,
        process,
        lock: { dev: value.lock.dev, ino: value.lock.ino },
      }
    : undefined;
}
