import { Injectable } from '@nestjs/common';

import { validPid, validUid } from '../process-identity.parser.js';
import type {
  IdentityObservation,
  ProcessIdentityAdapter,
  WorkingDirectoryObservation,
} from '../process-identity.types.js';

const BSD_INFO_SIZE = 136;
const SHORT_BSD_INFO_SIZE = 64;
const PROC_PIDTBSDINFO = 3;
const PROC_PIDT_SHORTBSDINFO = 13;
const PROC_PIDVNODEPATHINFO = 9;
const VNODE_PATH_INFO_SIZE = 2352;
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
    const binding = await this.loadedBinding();
    if (!binding) {
      return { kind: 'unknown', reason: 'unavailable' };
    }
    const buffer = Buffer.alloc(BSD_INFO_SIZE);
    const read = binding.pidInfo(pid, PROC_PIDTBSDINFO, 0n, buffer, buffer.length);
    if (read === 0) {
      return unreadable(binding, pid);
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

  async workingDirectory(pid: number): Promise<WorkingDirectoryObservation> {
    if (!validPid(pid)) {
      return { kind: 'unknown' };
    }
    const binding = await this.loadedBinding();
    if (!binding) {
      return { kind: 'unknown' };
    }
    const buffer = Buffer.alloc(VNODE_PATH_INFO_SIZE);
    const read = binding.pidInfo(pid, PROC_PIDVNODEPATHINFO, 0n, buffer, buffer.length);
    if (read === 0 && binding.noSuchProcess.includes(binding.errno())) {
      return { kind: 'missing' };
    }
    if (read !== VNODE_PATH_INFO_SIZE) {
      return { kind: 'unknown' };
    }
    return {
      kind: 'captured',
      directory: { device: BigInt(buffer.readUInt32LE(0)), inode: buffer.readBigUInt64LE(8) },
    };
  }

  private async loadedBinding(): Promise<DarwinBinding | undefined> {
    try {
      this.binding ??= this.loadBinding();
      return await this.binding;
    } catch {
      return undefined;
    }
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

function unreadable(binding: DarwinBinding, pid: number): IdentityObservation {
  const errorNumber = binding.errno();
  if (binding.noSuchProcess.includes(errorNumber)) {
    return { kind: 'missing' };
  }
  if (!binding.denied.includes(errorNumber)) {
    return { kind: 'unknown', reason: 'unavailable' };
  }
  return restricted(binding, pid);
}

/** Full BSD info covers only the caller's own processes; the short form names any owner. */
function restricted(binding: DarwinBinding, pid: number): IdentityObservation {
  const buffer = Buffer.alloc(SHORT_BSD_INFO_SIZE);
  const read = binding.pidInfo(pid, PROC_PIDT_SHORTBSDINFO, 0n, buffer, buffer.length);
  if (read === 0 && binding.noSuchProcess.includes(binding.errno())) {
    return { kind: 'missing' };
  }
  const uid = buffer.readUInt32LE(36);
  if (read !== SHORT_BSD_INFO_SIZE || buffer.readUInt32LE(0) !== pid || !validUid(uid)) {
    return { kind: 'unknown', reason: 'denied' };
  }
  if (buffer.readUInt32LE(12) === SZOMB) {
    return { kind: 'missing' };
  }
  return { kind: 'restricted', uid };
}
