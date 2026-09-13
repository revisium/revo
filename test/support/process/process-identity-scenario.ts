import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';

import {
  DarwinProcessIdentityAdapter,
  type DarwinBinding,
} from '../../../src/processes/adapters/darwin-process-identity.adapter.js';
import { LinuxProcessIdentityAdapter } from '../../../src/processes/adapters/linux-process-identity.adapter.js';
import { ProcessIdentityService } from '../../../src/processes/process-identity.service.js';
import type { ProcessIdentity } from '../../../src/processes/process-identity.types.js';
import { ProcessesModule } from '../../../src/processes/processes.module.js';

export class ProcessIdentityScenario {
  private readonly service = new ProcessIdentityService();
  private child: ChildProcess | undefined;
  private readonly fixtureRoots = new Set<string>();
  async capturesCurrentProcessThroughNest(): Promise<ProcessIdentity> {
    const context = await NestFactory.createApplicationContext(ProcessesModule, { logger: false });
    try {
      const identity = await context.get(ProcessIdentityService).capture(process.pid);
      console.log(`identity ABI platform=${process.platform} arch=${process.arch}`);
      return identity;
    } finally {
      await context.close();
    }
  }
  async capturesChildAndObservesExit() {
    const earliestBirthSecond = BigInt(Math.floor(Date.now() / 1000));
    const child = spawn(
      process.execPath,
      ['-e', "process.send?.('ready');setInterval(()=>{},1000)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
    });
    if (child.pid === undefined) {
      throw new Error('Identity fixture child did not start');
    }
    const identity = await this.service.capture(child.pid);
    const latestBirthSecond = BigInt(Math.floor(Date.now() / 1000));
    const whileRunning = await this.service.inspect(identity);
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const afterExit = await this.service.inspect(identity);
    const nativeBirthValid =
      identity.platform !== 'darwin' ||
      (BigInt(identity.birth.seconds) >= earliestBirthSecond &&
        BigInt(identity.birth.seconds) <= latestBirthSecond &&
        BigInt(identity.birth.microseconds) <= 999_999n);
    this.child = undefined;
    return { identity, whileRunning, afterExit, nativeBirthValid };
  }
  async rejectsChangedAndInvalidRecords(identity: ProcessIdentity) {
    const changed = {
      ...structuredClone(identity),
      uid: identity.uid === 0 ? 1 : identity.uid - 1,
    };
    const changedBirth =
      identity.platform === 'linux'
        ? {
            ...identity,
            birth: { ...identity.birth, startTicks: `${BigInt(identity.birth.startTicks) + 1n}` },
          }
        : {
            ...identity,
            birth: { ...identity.birth, seconds: `${BigInt(identity.birth.seconds) + 1n}` },
          };
    return Promise.all([
      this.service.inspect(changed),
      this.service.inspect(changedBirth),
      this.service.inspect({ ...identity, unexpected: 'unsafe' }),
    ]);
  }
  async provesLinuxParsing() {
    const root = await this.linuxFixture();
    const service = new ProcessIdentityService(
      new LinuxProcessIdentityAdapter(root),
      new DarwinProcessIdentityAdapter(),
      'linux',
    );
    return service.capture(123);
  }
  async provesMalformedLinuxIsUnknown() {
    const root = await this.linuxFixture();
    await writeFile(join(root, '123/status'), 'Uid:\t1000\t1001\t1000\t1000\n');
    return new LinuxProcessIdentityAdapter(root).capture(123);
  }
  async provesMismatchedLinuxPidIsUnknown() {
    const root = await this.linuxFixture();
    const stat = await readFile(join(root, '123/stat'), 'utf8');
    await writeFile(join(root, '123/stat'), stat.replace(/^123/u, '999'));
    return new LinuxProcessIdentityAdapter(root).capture(123);
  }
  async provesMalformedLinuxPidPrefixesAreUnknown() {
    return Promise.all(
      ['1.23e2', '+123', '0x7b'].map(async (prefix) => {
        const root = await this.linuxFixture();
        const stat = await readFile(join(root, '123/stat'), 'utf8');
        await writeFile(join(root, '123/stat'), stat.replace(/^123/u, prefix));
        return new LinuxProcessIdentityAdapter(root).capture(123);
      }),
    );
  }
  async provesDarwinBoundary() {
    const buffer = Buffer.alloc(136);
    buffer.writeUInt32LE(2, 4);
    buffer.writeInt32LE(77, 12);
    buffer.writeUInt32LE(501, 20);
    buffer.writeUInt32LE(501, 28);
    buffer.writeBigUInt64LE(9_007_199_254_740_993n, 120);
    buffer.writeBigUInt64LE(42n, 128);
    const adapter = new FixtureDarwinAdapter({
      pidInfo: (_p, _f, _a, destination) => (buffer.copy(destination), 136),
      errno: () => 0,
      noSuchProcess: [3],
      denied: [1, 13],
    });
    const complete = await adapter.capture(77);
    adapter.result = 12;
    const partial = await adapter.capture(77);
    adapter.result = 0;
    const failed = await adapter.capture(77);
    return { complete, partial, failed };
  }
  async cleanup(): Promise<void> {
    this.child?.kill('SIGKILL');
    await Promise.all(
      [...this.fixtureRoots].map((root) => rm(root, { recursive: true, force: true })),
    );
  }
  private async linuxFixture(): Promise<string> {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'revo-identity-'));
    this.fixtureRoots.add(fixtureRoot);
    await mkdir(join(fixtureRoot, 'sys/kernel/random'), { recursive: true });
    await mkdir(join(fixtureRoot, '123'));
    await writeFile(
      join(fixtureRoot, 'sys/kernel/random/boot_id'),
      '123e4567-e89b-42d3-a456-426614174000\n',
    );
    const fields = ['S', ...Array.from({ length: 18 }, () => '0'), '18446744073709551614'];
    await writeFile(
      join(fixtureRoot, '123/stat'),
      `123 (worker ) name) ${fields.join(' ')}\n`,
    );
    await writeFile(join(fixtureRoot, '123/status'), 'Uid:\t1000\t1000\t1000\t1000\n');
    return fixtureRoot;
  }
}
class FixtureDarwinAdapter extends DarwinProcessIdentityAdapter {
  result = 136;
  constructor(private readonly fixture: DarwinBinding) {
    super();
  }
  protected override async loadBinding(): Promise<DarwinBinding> {
    return {
      ...this.fixture,
      pidInfo: (...args) => (this.result === 136 ? this.fixture.pidInfo(...args) : this.result),
    };
  }
}
