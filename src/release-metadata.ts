import type { ReleaseChannel } from './layout.js';

const SEMVER_IDENTIFIER = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER_PATTERN = new RegExp(
  String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(${SEMVER_IDENTIFIER}(?:\.${SEMVER_IDENTIFIER})*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
);

interface ReleaseMetadata {
  channel: ReleaseChannel;
  npm: {
    distTag: 'latest' | 'alpha';
    name: '@revisium/revo';
  };
  schemaVersion: 1;
  version: string;
}

export function isSemVerString(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidMetadata(reason: string): Error {
  return new Error(`Invalid Revo release metadata: ${reason}`);
}

export function parseReleaseMetadata(value: unknown): ReleaseMetadata {
  if (!isRecord(value) || !hasExactKeys(value, ['channel', 'npm', 'schemaVersion', 'version'])) {
    throw invalidMetadata('expected schemaVersion, channel, version, and npm fields');
  }
  if (value.schemaVersion !== 1) {
    throw invalidMetadata('schemaVersion must be 1');
  }
  if (value.channel !== 'stable' && value.channel !== 'alpha') {
    throw invalidMetadata('channel must be stable or alpha');
  }
  if (typeof value.version !== 'string' || !isSemVerString(value.version)) {
    throw invalidMetadata('version must be valid SemVer');
  }
  if (!isRecord(value.npm) || !hasExactKeys(value.npm, ['distTag', 'name'])) {
    throw invalidMetadata('npm must contain only name and distTag');
  }
  if (value.npm.name !== '@revisium/revo') {
    throw invalidMetadata('npm.name must be @revisium/revo');
  }

  const prerelease = SEMVER_PATTERN.exec(value.version)?.[4];
  const expectedDistTag = value.channel === 'stable' ? 'latest' : 'alpha';
  if (value.npm.distTag !== expectedDistTag) {
    throw invalidMetadata(`${value.channel} releases must use the ${expectedDistTag} npm dist-tag`);
  }
  if (value.channel === 'stable' && prerelease !== undefined) {
    throw invalidMetadata('stable releases cannot use prerelease versions');
  }
  if (value.channel === 'alpha' && prerelease === undefined) {
    throw invalidMetadata('alpha releases must use prerelease versions');
  }

  return {
    schemaVersion: 1,
    channel: value.channel,
    version: value.version,
    npm: {
      name: '@revisium/revo',
      distTag: expectedDistTag,
    },
  };
}

/** Orders SemVer versions by precedence, negative when `left` is older; build metadata is ignored. */
export function compareSemVer(left: string, right: string): number {
  const first = parseSemVer(left);
  const second = parseSemVer(right);
  const core = compareIdentifiers(first.core, second.core);
  if (core !== 0) {
    return core;
  }
  if (first.prerelease.length === 0 || second.prerelease.length === 0) {
    return second.prerelease.length - first.prerelease.length;
  }
  return compareIdentifiers(first.prerelease, second.prerelease);
}

function parseSemVer(value: string) {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    throw new Error(`${value} is not a SemVer version`);
  }
  return {
    core: [match[1], match[2], match[3]].map(String),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function compareIdentifiers(left: readonly string[], right: readonly string[]): number {
  const index = left.findIndex((identifier, position) => identifier !== right[position]);
  if (index === -1 || index >= right.length) {
    return left.length - right.length;
  }
  return compareIdentifier(String(left[index]), String(right[index]));
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    return Math.sign(Number(BigInt(left) - BigInt(right)));
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return Number(left > right) - Number(left < right);
}
