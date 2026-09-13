import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { parseLinuxStat, parseLinuxUid, validPid } from '../process-identity.parser.js';
import type { IdentityObservation, ProcessIdentityAdapter } from '../process-identity.types.js';

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
const PROC_ROOT = Symbol('PROC_ROOT');

@Injectable()
export class LinuxProcessIdentityAdapter implements ProcessIdentityAdapter {
  constructor(@Optional() @Inject(PROC_ROOT) private readonly procRoot = '/proc') {}

  async capture(pid: number): Promise<IdentityObservation> {
    if (!validPid(pid)) {
      return { kind: 'unknown', reason: 'invalid-record' };
    }
    let bootId: string;
    try {
      bootId = (await readFile(join(this.procRoot, 'sys/kernel/random/boot_id'), 'utf8'))
        .trim()
        .toLowerCase();
    } catch (error) {
      return { kind: 'unknown', reason: code(error) === 'EACCES' ? 'denied' : 'unavailable' };
    }
    if (!BOOT_ID.test(bootId)) {
      return { kind: 'unknown', reason: 'malformed' };
    }
    try {
      const directory = join(this.procRoot, String(pid));
      const first = parseLinuxStat(await readFile(join(directory, 'stat'), 'utf8'));
      if (!first) {
        return { kind: 'unknown', reason: 'malformed' };
      }
      if (first.pid !== pid) {
        return { kind: 'unknown', reason: 'unstable' };
      }
      if (first.state === 'Z' || first.state === 'X') {
        return { kind: 'missing' };
      }
      const uid = parseLinuxUid(await readFile(join(directory, 'status'), 'utf8'));
      const second = parseLinuxStat(await readFile(join(directory, 'stat'), 'utf8'));
      if (uid === undefined || !second) {
        return { kind: 'unknown', reason: 'malformed' };
      }
      if (second.pid !== pid) {
        return { kind: 'unknown', reason: 'unstable' };
      }
      if (second.state === 'Z' || second.state === 'X') {
        return { kind: 'missing' };
      }
      if (first.startTicks !== second.startTicks) {
        return { kind: 'unknown', reason: 'unstable' };
      }
      return {
        kind: 'captured',
        identity: { platform: 'linux', pid, uid, birth: { bootId, startTicks: first.startTicks } },
      };
    } catch (error) {
      const errorCode = code(error);
      if (errorCode === 'ENOENT' || errorCode === 'ESRCH') {
        return { kind: 'missing' };
      }
      return {
        kind: 'unknown',
        reason: errorCode === 'EACCES' || errorCode === 'EPERM' ? 'denied' : 'unavailable',
      };
    }
  }
}
