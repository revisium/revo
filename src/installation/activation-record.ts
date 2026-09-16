// oxlint-disable curly, no-shadow, no-unsafe-type-assertion -- bounded record parser

import { parseReleaseMetadata } from '../release-metadata.js';
import type { PreparedPackageReceipt } from './prepared-package.js';

export const ACTIVATION_SCHEMA = 'revo-activation/v1' as const;
export const ACTIVATION_LAUNCHER_PROTOCOL = 'revo-activation-launcher/v2' as const;
export const ACTIVATION_RECORD_LIMIT = 16 * 1024;

export class ActivationRecordError extends Error {
  readonly code = 'REVO_ACTIVATION_STATE_INCOMPATIBLE' as const;

  constructor(
    message = 'activation state format is incompatible; reinstall the compatible release',
  ) {
    super(message);
    this.name = 'ActivationRecordError';
  }
}

export interface ActivationBinding {
  readonly channelRoot: string;
  readonly generationId: string;
}

export interface ActivationRecord {
  readonly schemaVersion: typeof ACTIVATION_SCHEMA;
  readonly launcherProtocol: typeof ACTIVATION_LAUNCHER_PROTOCOL;
  readonly generationId: string;
  readonly channel: 'stable' | 'alpha';
  readonly target: { readonly platform: string; readonly arch: string };
  readonly release: PreparedPackageReceipt['release'];
  readonly components: PreparedPackageReceipt['components'];
  readonly packageRef: string;
  readonly packageBin: string;
  readonly packageDigests: PreparedPackageReceipt['artifacts'];
  readonly toolchain: {
    readonly nodeRef: string;
    readonly pnpmRef: string;
    readonly nodeVersion: string;
    readonly pnpmVersion: string;
    readonly nodeArchiveSha256: string;
    readonly pnpmArchiveSha256: string;
  };
  readonly previousGeneration: string | null;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const digests = (value: unknown): value is PreparedPackageReceipt['artifacts'] => {
  if (!record(value) || !exact(value, ['package', 'packageJson', 'pnpmLock', 'pnpmWorkspace']))
    return false;
  for (const [name, item] of Object.entries(value)) {
    if (
      !record(item) ||
      !exact(item, name === 'package' ? ['integrity', 'sha256'] : ['sha256']) ||
      !hash(item.sha256)
    )
      return false;
    if (
      name === 'package' &&
      (typeof item.integrity !== 'string' || !item.integrity.startsWith('sha512-'))
    )
      return false;
  }
  return true;
};
const components = (value: unknown): boolean => {
  if (
    !record(value) ||
    !exact(value, ['admin', 'core']) ||
    !record(value.core) ||
    !record(value.admin)
  )
    return false;
  return (
    exact(value.core, ['name', 'version']) &&
    exact(value.admin, ['name', 'version']) &&
    string(value.core.name) &&
    string(value.core.version) &&
    string(value.admin.name) &&
    string(value.admin.version)
  );
};

export function parseActivationRecord(value: unknown): ActivationRecord {
  if (
    record(value) &&
    value.schemaVersion === ACTIVATION_SCHEMA &&
    !Object.hasOwn(value, 'launcherProtocol')
  ) {
    throw new ActivationRecordError('launcher protocol revision is missing');
  }
  if (
    record(value) &&
    value.schemaVersion === ACTIVATION_SCHEMA &&
    Object.hasOwn(value, 'launcherProtocol') &&
    value.launcherProtocol !== ACTIVATION_LAUNCHER_PROTOCOL
  ) {
    throw new ActivationRecordError('launcher protocol revision is unsupported');
  }
  if (
    !record(value) ||
    !exact(value, [
      'channel',
      'components',
      'generationId',
      'launcherProtocol',
      'packageBin',
      'packageDigests',
      'packageRef',
      'previousGeneration',
      'release',
      'schemaVersion',
      'target',
      'toolchain',
    ]) ||
    value.schemaVersion !== ACTIVATION_SCHEMA ||
    value.launcherProtocol !== ACTIVATION_LAUNCHER_PROTOCOL ||
    !/^[a-f0-9]{64}$/u.test(String(value.generationId)) ||
    (value.channel !== 'stable' && value.channel !== 'alpha') ||
    !record(value.target) ||
    !exact(value.target, ['arch', 'platform']) ||
    !string(value.target.platform) ||
    !string(value.target.arch) ||
    !record(value.release) ||
    !components(value.components) ||
    (() => {
      try {
        parseReleaseMetadata(value.release);
        return false;
      } catch {
        return true;
      }
    })() ||
    !string(value.packageRef) ||
    !string(value.packageBin) ||
    !digests(value.packageDigests) ||
    !record(value.toolchain) ||
    !exact(value.toolchain, [
      'nodeArchiveSha256',
      'nodeRef',
      'nodeVersion',
      'pnpmArchiveSha256',
      'pnpmRef',
      'pnpmVersion',
    ]) ||
    !string(value.toolchain.nodeRef) ||
    !string(value.toolchain.pnpmRef) ||
    !string(value.toolchain.nodeVersion) ||
    !string(value.toolchain.pnpmVersion) ||
    !hash(value.toolchain.nodeArchiveSha256) ||
    !hash(value.toolchain.pnpmArchiveSha256) ||
    (value.previousGeneration !== null &&
      (typeof value.previousGeneration !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(value.previousGeneration)))
  )
    throw new Error('activation record is invalid');
  return value as unknown as ActivationRecord;
}

export const activationIdentity = (record: ActivationRecord): string =>
  JSON.stringify({
    channel: record.channel,
    launcherProtocol: record.launcherProtocol,
    target: record.target,
    release: record.release,
    components: record.components,
    packageRef: record.packageRef,
    packageBin: record.packageBin,
    packageDigests: record.packageDigests,
    toolchain: record.toolchain,
  });
