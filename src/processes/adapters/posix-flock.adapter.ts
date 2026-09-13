import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export interface FlockBinding {
  readonly call: (descriptor: number, operation: number) => number;
  readonly errno: () => number;
  readonly tryAgain: number;
  readonly wouldBlock: number;
}

export interface NativeLock {
  readonly descriptor: number;
  unlock(): void;
}

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

export class PosixFlockAdapter {
  private binding: Promise<FlockBinding> | undefined;

  async lock(file: FileHandle): Promise<NativeLock | undefined> {
    const binding = await (this.binding ??= this.loadBinding());
    const result = binding.call(file.fd, LOCK_EX | LOCK_NB);
    const errno = result === -1 ? binding.errno() : undefined;
    if (result === 0) {
      return {
        descriptor: file.fd,
        unlock: () => this.unlock(binding, file.fd),
      };
    }
    if (errno === binding.wouldBlock || errno === binding.tryAgain) {
      return undefined;
    }
    throw new Error(`Unable to acquire server ownership lock (errno ${String(errno)}).`);
  }

  openFlags(platform: NodeJS.Platform): number {
    const closeOnExec = this.optionalConstant('O_CLOEXEC') ?? this.platformCloseOnExec(platform);
    const noFollow = this.requiredConstant('O_NOFOLLOW');
    return constants.O_CREAT | constants.O_RDWR | closeOnExec | noFollow;
  }

  private unlock(binding: FlockBinding, descriptor: number): void {
    const result = binding.call(descriptor, LOCK_UN);
    const errno = result === -1 ? binding.errno() : undefined;
    if (result !== 0) {
      throw new Error(`Unable to release server ownership lock (errno ${String(errno)}).`);
    }
  }

  protected async loadBinding(): Promise<FlockBinding> {
    const koffi = (await import('koffi')).default;
    const library = koffi.load(
      process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    );
    return {
      call: library.func('int flock(int fd, int operation)'),
      errno: koffi.errno,
      tryAgain: this.nativeErrno(koffi.os.errno, 'EAGAIN'),
      wouldBlock: this.nativeErrno(koffi.os.errno, 'EWOULDBLOCK'),
    };
  }

  private platformCloseOnExec(platform: NodeJS.Platform): number {
    if (platform === 'linux') {
      return 0x80_000;
    }
    if (platform === 'darwin') {
      return 0x100_0000;
    }
    throw new Error(`Server ownership is unsupported on ${platform}.`);
  }

  private optionalConstant(name: string): number | undefined {
    const value = Reflect.get(constants, name);
    return typeof value === 'number' ? value : undefined;
  }

  private requiredConstant(name: string): number {
    const value = this.optionalConstant(name);
    if (value === undefined) {
      throw new Error(`${name} is unavailable on this platform.`);
    }
    return value;
  }

  private nativeErrno(errnoConstants: Readonly<Record<string, number>>, name: string): number {
    const value = errnoConstants[name];
    if (value === undefined) {
      throw new Error(`${name} is unavailable on this platform.`);
    }
    return value;
  }
}
