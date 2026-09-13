import { Inject, Injectable } from '@nestjs/common';

import { DarwinProcessIdentityAdapter } from './adapters/darwin-process-identity.adapter.js';
import { LinuxProcessIdentityAdapter } from './adapters/linux-process-identity.adapter.js';
import { parseIdentity, validPid } from './process-identity.parser.js';
import type {
  ProcessIdentity,
  ProcessIdentityAdapter,
  ProcessIdentityInspection,
} from './process-identity.types.js';

export const PROCESS_IDENTITY_PLATFORM = Symbol('PROCESS_IDENTITY_PLATFORM');
export type IdentityPlatform = 'linux' | 'darwin' | 'unsupported';

export class ProcessIdentityError extends Error {
  readonly code = 'PROCESS_IDENTITY_UNAVAILABLE';
  constructor() {
    super('Process identity could not be captured');
    this.name = 'ProcessIdentityError';
  }
}

@Injectable()
export class ProcessIdentityService {
  constructor(
    @Inject(LinuxProcessIdentityAdapter) private readonly linux = new LinuxProcessIdentityAdapter(),
    @Inject(DarwinProcessIdentityAdapter)
    private readonly darwin = new DarwinProcessIdentityAdapter(),
    @Inject(PROCESS_IDENTITY_PLATFORM)
    private readonly platform: IdentityPlatform = process.platform === 'linux' ||
    process.platform === 'darwin'
      ? process.platform
      : 'unsupported',
  ) {}

  async capture(pid: number): Promise<ProcessIdentity> {
    if (!validPid(pid)) {
      throw new ProcessIdentityError();
    }
    const observation = await this.adapter()?.capture(pid);
    if (observation?.kind !== 'captured') {
      throw new ProcessIdentityError();
    }
    return observation.identity;
  }

  async inspect(expectedRecord: unknown): Promise<ProcessIdentityInspection> {
    const expected = parseIdentity(expectedRecord);
    if (!expected) {
      return { kind: 'unknown', reason: 'invalid-record' };
    }
    if (expected.platform !== this.platform) {
      return { kind: 'mismatch' };
    }
    const observation = await this.adapter()?.capture(expected.pid);
    if (!observation) {
      return { kind: 'unknown', reason: 'unavailable' };
    }
    if (observation.kind !== 'captured') {
      return observation;
    }
    return sameIdentity(expected, observation.identity)
      ? { kind: 'confirmed' }
      : { kind: 'mismatch' };
  }

  private adapter(): ProcessIdentityAdapter | undefined {
    if (this.platform === 'linux') {
      return this.linux;
    }
    if (this.platform === 'darwin') {
      return this.darwin;
    }
    return undefined;
  }
}

const sameIdentity = (left: ProcessIdentity, right: ProcessIdentity) =>
  left.platform === right.platform && JSON.stringify(left) === JSON.stringify(right);
