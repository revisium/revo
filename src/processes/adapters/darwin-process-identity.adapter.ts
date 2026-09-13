import { Injectable } from '@nestjs/common';

import { validPid, validUid } from '../process-identity.parser.js';
import type { IdentityObservation, ProcessIdentityAdapter } from '../process-identity.types.js';

const BSD_INFO_SIZE = 136;
const PROC_PIDTBSDINFO = 3;
const SZOMB = 5;

export interface DarwinBinding {
  readonly pidInfo: (
    pid: number,
    flavor: number,
    argument: bigint,
    buffer: Buffer,
    size: number,
  ) => number;
  readonly errno: () => number;
  readonly noSuchProcess: readonly number[];
  readonly denied: readonly number[];
}

@Injectable()
export class DarwinProcessIdentityAdapter implements ProcessIdentityAdapter {
  private binding?: Promise<DarwinBinding>;

  async capture(pid: number): Promise<IdentityObservation> {
    if (!validPid(pid)) {
      return { kind: 'unknown', reason: 'invalid-record' };
    }
    let binding: DarwinBinding;
    try {
      binding = await (this.binding ??= this.loadBinding());
    } catch {
      return { kind: 'unknown', reason: 'unavailable' };
    }
    const buffer = Buffer.alloc(BSD_INFO_SIZE);
    const read = binding.pidInfo(pid, PROC_PIDTBSDINFO, 0n, buffer, buffer.length);
    const errorNumber = read === 0 ? binding.errno() : undefined;
    if (read === 0) {
      if (errorNumber !== undefined && binding.noSuchProcess.includes(errorNumber)) {
        return { kind: 'missing' };
      }
      return {
        kind: 'unknown',
        reason:
          errorNumber !== undefined && binding.denied.includes(errorNumber)
            ? 'denied'
            : 'unavailable',
      };
    }
    if (read !== BSD_INFO_SIZE) {
      return { kind: 'unknown', reason: 'malformed' };
    }
    const status = buffer.readUInt32LE(4);
    if (status === SZOMB) {
      return { kind: 'missing' };
    }
    const observedPid = buffer.readInt32LE(12);
    const effectiveUid = buffer.readUInt32LE(20);
    const realUid = buffer.readUInt32LE(28);
    const seconds = buffer.readBigUInt64LE(120);
    const microseconds = buffer.readBigUInt64LE(128);
    if (
      observedPid !== pid ||
      !validUid(effectiveUid) ||
      effectiveUid !== realUid ||
      microseconds > 999_999n
    ) {
      return { kind: 'unknown', reason: 'malformed' };
    }
    return {
      kind: 'captured',
      identity: {
        platform: 'darwin',
        pid,
        uid: realUid,
        birth: { seconds: seconds.toString(), microseconds: microseconds.toString() },
      },
    };
  }

  protected async loadBinding(): Promise<DarwinBinding> {
    const koffi = await import('koffi');
    const library = koffi.default.load('/usr/lib/libproc.dylib');
    const pidInfo = library.func(
      'int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)',
    );
    return {
      pidInfo: pidInfo as DarwinBinding['pidInfo'],
      errno: koffi.default.errno,
      noSuchProcess: [koffi.default.os.errno.ESRCH ?? 3],
      denied: [koffi.default.os.errno.EACCES ?? 13, koffi.default.os.errno.EPERM ?? 1],
    };
  }
}
