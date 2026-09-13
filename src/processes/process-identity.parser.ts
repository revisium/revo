import type { ProcessIdentity } from './process-identity.types.js';

const UINT64_MAX = 18_446_744_073_709_551_615n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL = /^(?:0|[1-9]\d*)$/u;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export const validPid = (pid: unknown): pid is number =>
  Number.isInteger(pid) && Number(pid) >= 1 && Number(pid) <= 2_147_483_647;
export const validUid = (uid: unknown): uid is number =>
  Number.isInteger(uid) && Number(uid) >= 0 && Number(uid) <= 4_294_967_295;
export const validUint64 = (value: unknown): value is string => {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    return false;
  }
  return BigInt(value) <= UINT64_MAX;
};

export function parseIdentity(value: unknown): ProcessIdentity | undefined {
  if (!record(value) || !exact(value, ['platform', 'pid', 'uid', 'birth'])) {
    return undefined;
  }
  if (!validPid(value.pid) || !validUid(value.uid) || !record(value.birth)) {
    return undefined;
  }
  if (value.platform === 'linux' && exact(value.birth, ['bootId', 'startTicks'])) {
    const bootId = value.birth.bootId;
    if (typeof bootId === 'string' && UUID.test(bootId) && validUint64(value.birth.startTicks)) {
      return {
        platform: 'linux',
        pid: value.pid,
        uid: value.uid,
        birth: { bootId, startTicks: value.birth.startTicks },
      };
    }
  }
  if (value.platform === 'darwin' && exact(value.birth, ['seconds', 'microseconds'])) {
    const { seconds, microseconds } = value.birth;
    if (validUint64(seconds) && validUint64(microseconds) && BigInt(microseconds) <= 999_999n) {
      return {
        platform: 'darwin',
        pid: value.pid,
        uid: value.uid,
        birth: { seconds, microseconds },
      };
    }
  }
  return undefined;
}

export interface LinuxStat {
  readonly pid: number;
  readonly state: string;
  readonly startTicks: string;
}
export function parseLinuxStat(text: string): LinuxStat | undefined {
  const close = text.lastIndexOf(')');
  const open = text.indexOf(' (');
  const pidText = text.slice(0, open);
  const pid = Number(pidText);
  if (
    open < 1 ||
    close <= open + 2 ||
    !/^[1-9]\d*$/u.test(pidText) ||
    !validPid(pid) ||
    text[close + 1] !== ' '
  ) {
    return undefined;
  }
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  if (fields.length <= 19 || !/^[A-Z]$/u.test(fields[0] ?? '') || !validUint64(fields[19])) {
    return undefined;
  }
  return { pid, state: fields[0] ?? '', startTicks: fields[19] ?? '' };
}

export function parseLinuxUid(text: string): number | undefined {
  const line = text.split('\n').find((candidate) => candidate.startsWith('Uid:'));
  if (!line) {
    return undefined;
  }
  const fields = line.slice(4).trim().split(/\s+/u);
  if (fields.length !== 4 || !fields.every((field) => /^(?:0|[1-9]\d*)$/u.test(field))) {
    return undefined;
  }
  const values = fields.map(Number);
  if (!values.every(validUid) || values[0] !== values[1]) {
    return undefined;
  }
  return values[0];
}
