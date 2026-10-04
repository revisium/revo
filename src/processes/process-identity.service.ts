import { uptime } from 'node:os';

import { Inject, Injectable } from '@nestjs/common';

import { DarwinProcessIdentityAdapter } from './adapters/darwin-process-identity.adapter.js';
import { LinuxProcessIdentityAdapter } from './adapters/linux-process-identity.adapter.js';
import { parseIdentity, validPid } from './process-identity.parser.js';
import type {
  IdentityObservation,
  ProcessIdentity,
  ProcessIdentityAdapter,
  ProcessIdentityInspection,
  WorkingDirectoryObservation,
} from './process-identity.types.js';

const LINUX_CLOCK_TICKS_PER_SECOND = 100;

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
    const observation = await this.observe(pid);
    if (observation.kind !== 'captured') {
      throw new ProcessIdentityError();
    }
    return observation.identity;
  }

  async observe(pid: number): Promise<IdentityObservation> {
    if (!validPid(pid)) {
      return { kind: 'unknown', reason: 'invalid-record' };
    }
    return (await this.adapter()?.capture(pid)) ?? { kind: 'unknown', reason: 'unavailable' };
  }

  async workingDirectory(pid: number): Promise<WorkingDirectoryObservation> {
    return (await this.adapter()?.workingDirectory(pid)) ?? { kind: 'unknown' };
  }

  bootedAt(): number {
    return Date.now() / 1000 - uptime();
  }

  startedAt(identity: ProcessIdentity): number {
    if (identity.platform === 'darwin') {
      return Number(identity.birth.seconds) + Number(identity.birth.microseconds) / 1_000_000;
    }
    return this.bootedAt() + Number(identity.birth.startTicks) / LINUX_CLOCK_TICKS_PER_SECOND;
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
