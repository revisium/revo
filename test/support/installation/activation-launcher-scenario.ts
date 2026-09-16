import { spawn } from 'node:child_process';
import { mkdir, readFile, readlink, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { acquireActivationOwnership } from '../../../src/installation/activation-ownership.js';
import {
  activatePreparedInstallation,
  type ActivationCandidate,
} from '../../../src/installation/activation-store.js';
import { preparedPackageTarget } from '../../../src/installation/prepared-package.js';
import { cleanupPortableToolchain, portableToolchain } from './installer-toolchain-scenario.js';

type Run = { readonly execPath: string; readonly argv: string[]; readonly cwd: string };
const parseRun = (value: string): Run => {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('activation run is invalid');
  }
  const execPath = Object.getOwnPropertyDescriptor(parsed, 'execPath')?.value;
  const argvValue = Object.getOwnPropertyDescriptor(parsed, 'argv')?.value;
  const cwd = Object.getOwnPropertyDescriptor(parsed, 'cwd')?.value;
  if (typeof execPath !== 'string' || typeof cwd !== 'string' || !Array.isArray(argvValue)) {
    throw new Error('activation run is invalid');
  }
  const argv: string[] = [];
  for (const item of argvValue) {
    if (typeof item !== 'string') {
      throw new Error('activation run is invalid');
    }
    argv.push(item);
  }
  return { execPath, argv, cwd };
};

export async function activationLauncherScenario() {
  const subject = await portableToolchain('stable', '1.2.3', true);
  const installRoot = join(subject.root, "state with 'quote");
  const exitCode = await subject.startInstaller({ REVO_INSTALL_ROOT: installRoot }).finish;
  if (exitCode !== 0) {
    throw new Error('generated installer failed');
  }
  const channelRoot = join(installRoot, 'stable');
  const target = {
    platform: process.platform === 'darwin' ? ('darwin' as const) : ('linux' as const),
    arch: process.arch === 'arm64' ? ('arm64' as const) : ('x64' as const),
  };
  const plan = { ...subject.plan, target };
  const identity = `${target.platform}-${target.arch}`;
  const candidate: ActivationCandidate = {
    plan,
    packageDirectory: preparedPackageTarget(channelRoot, plan),
    packageBin: 'dist/bin/revo.js',
    nodeDirectory: join(channelRoot, 'node', plan.toolchain.node, identity),
    pnpmDirectory: join(channelRoot, 'pnpm', plan.toolchain.node, identity, plan.toolchain.pnpm),
    nodeArchiveSha256: subject.nodeArchiveSha256,
    pnpmArchiveSha256: subject.pnpmArchiveSha256,
  };
  const ownership = await acquireActivationOwnership({ channelRoot, channel: 'stable' });
  if (ownership.status !== 'held') {
    throw new Error('activation ownership unavailable');
  }
  const lease = ownership.lease;
  const activate = () => activatePreparedInstallation({ channelRoot, candidate, lease });
  return {
    root: subject.root,
    channelRoot,
    candidate,
    packageBinMode: async () =>
      (await stat(join(candidate.packageDirectory, candidate.packageBin))).mode & 0o777,
    activate,
    readEntrypoint: async () =>
      readFile(join(channelRoot, await readlink(join(channelRoot, 'current')), 'revo'), 'utf8'),
    executeCurrent: async (args: readonly string[] = [], extra: Record<string, string> = {}) => {
      const output = join(subject.root, 'activation-output.jsonl');
      const cwd = join(subject.root, "cwd with 'quote");
      await mkdir(cwd, { recursive: true });
      await rm(output, { force: true });
      const executable = join(channelRoot, await readlink(join(channelRoot, 'current')), 'revo');
      const result = await new Promise<{
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }>((resolve) => {
        const child = spawn(executable, args, {
          cwd,
          env: {
            ...process.env,
            PATH: join(subject.root, 'poison'),
            NODE_OPTIONS: '',
            REVO_ACTIVATION_OUTPUT: output,
            ...extra,
          },
          stdio: 'ignore',
        });
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      const recorded = await readFile(output, 'utf8').catch(() => undefined);
      return { ...result, ...(recorded === undefined ? {} : { run: parseRun(recorded) }) };
    },
    cleanup: async () => {
      await lease.release();
      await cleanupPortableToolchain(subject.root);
    },
  };
}
