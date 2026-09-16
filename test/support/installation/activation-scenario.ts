import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activatePreparedInstallation,
  readActivation,
  type ActivationCandidate,
} from '../../../src/installation/activation-store.js';
import {
  createPackageInstallPlan,
  type PackageInstallPlan,
} from '../../../src/installation/package-install-plan.js';
import {
  preparedPackageTarget,
  publishPreparedPackage,
} from '../../../src/installation/prepared-package.js';
import { packageReleaseFixture } from './package-release-fixture.js';

const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const lease = { assertHeld: () => undefined };

async function candidate(root: string, version: string): Promise<ActivationCandidate> {
  const fixture = packageReleaseFixture({ version });
  const source = createPackageInstallPlan(fixture.manifest, fixture.request);
  const packageJson = Buffer.from(
    JSON.stringify({ name: '@revisium/revo', version, bin: { revo: 'bin/revo.js' } }),
  );
  const plan: PackageInstallPlan = {
    ...source,
    artifacts: {
      ...source.artifacts,
      packageJson: { ...source.artifacts.packageJson, sha256: digest(packageJson) },
    },
  };
  const stage = join(root, `stage-${version}`);
  await mkdir(join(stage, 'node_modules'), { recursive: true });
  await mkdir(join(stage, 'bin'), { recursive: true });
  await writeFile(join(stage, 'package.json'), packageJson);
  await writeFile(join(stage, 'bin', 'revo.js'), '#!/usr/bin/env node\n');
  await chmod(join(stage, 'bin', 'revo.js'), 0o755);
  await writeFile(join(stage, 'pnpm-lock.yaml'), fixture.bytes.pnpmLock);
  await writeFile(join(stage, 'pnpm-workspace.yaml'), fixture.bytes.pnpmWorkspace);
  const packageDirectory = preparedPackageTarget(root, plan);
  await publishPreparedPackage({ plan, stage, channelRoot: root });
  const target = `${plan.target.platform}-${plan.target.arch}`;
  const nodeDirectory = join(root, 'node', plan.toolchain.node, target);
  const pnpmDirectory = join(root, 'pnpm', plan.toolchain.node, target, plan.toolchain.pnpm);
  await mkdir(join(nodeDirectory, 'bin'), { recursive: true });
  await writeFile(join(nodeDirectory, 'bin', 'node'), '#!/bin/sh\n');
  await chmod(join(nodeDirectory, 'bin', 'node'), 0o755);
  await writeFile(
    join(nodeDirectory, 'install-receipt.json'),
    `${JSON.stringify({ version: plan.toolchain.node, target, archiveSha256: '1'.repeat(64) })}\n`,
    { mode: 0o600 },
  );
  await mkdir(pnpmDirectory, { recursive: true });
  await writeFile(join(pnpmDirectory, 'pnpm'), '#!/bin/sh\n');
  await chmod(join(pnpmDirectory, 'pnpm'), 0o755);
  await writeFile(
    join(pnpmDirectory, 'install-receipt.json'),
    `${JSON.stringify({ schemaVersion: 'revo-pnpm-bootstrap/v1', version: plan.toolchain.pnpm, nodeVersion: plan.toolchain.node, platform: plan.target.platform, arch: plan.target.arch, archiveSha256: '2'.repeat(64) })}\n`,
    { mode: 0o600 },
  );
  return {
    plan,
    packageDirectory,
    packageBin: 'bin/revo.js',
    nodeDirectory,
    pnpmDirectory,
    nodeArchiveSha256: '1'.repeat(64),
    pnpmArchiveSha256: '2'.repeat(64),
  };
}

export async function activationScenario() {
  const root = await mkdtemp(join(tmpdir(), 'revo-activation-'));
  const channelRoot = join(root, 'stable');
  await mkdir(channelRoot, { mode: 0o755 });
  const first = await candidate(channelRoot, '1.2.3');
  const next = await candidate(channelRoot, '1.2.4');
  const activate = (input: Partial<Parameters<typeof activatePreparedInstallation>[0]> = {}) =>
    activatePreparedInstallation({ channelRoot, candidate: first, lease, ...input });
  return {
    root,
    channelRoot,
    currentPath: join(channelRoot, 'current'),
    userData: await writeFile(join(root, 'user-data'), 'keep').then(() => join(root, 'user-data')),
    first,
    next,
    activate,
    activateNext: () => activatePreparedInstallation({ channelRoot, candidate: next, lease }),
    competitor: () =>
      activatePreparedInstallation({
        channelRoot,
        candidate: next,
        expectedCurrent: '0'.repeat(64),
        lease,
      }),
    currentGeneration: async () => {
      const value = await readActivation(channelRoot);
      if (value.status !== 'valid') {
        throw new Error('current activation is not valid');
      }
      return value.record.generationId;
    },
    currentGenerationPath: async () => {
      const generation = await readlink(join(channelRoot, 'current'));
      return join(channelRoot, generation);
    },
    readEntrypoint: async () => {
      const generation = await readlink(join(channelRoot, 'current'));
      return readFile(join(channelRoot, generation, 'revo'), 'utf8');
    },
    previousTarget: () => first.packageDirectory,
    snapshot: async () => ({
      current: await readlink(join(channelRoot, 'current')),
      entries: await stat(channelRoot),
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
