import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPackageInstallPlan } from '../../../src/installation/package-install-plan.js';
import {
  preparedPackageReceipt,
  preparedPackageTarget,
  publishPreparedPackage,
  readPreparedPackage,
} from '../../../src/installation/prepared-package.js';
import { packageReleaseFixture } from './package-release-fixture.js';

export async function installerPackageScenario() {
  const fixture = packageReleaseFixture();
  const plan = createPackageInstallPlan(fixture.manifest, fixture.request);
  const root = await mkdtemp(join(tmpdir(), 'revo-installer-package-'));
  const channelRoot = join(root, 'stable');
  const stage = join(root, 'stage');
  await mkdir(channelRoot, { recursive: true });
  await mkdir(stage, { recursive: true });
  await mkdir(join(stage, 'node_modules'), { recursive: true });
  await writeFile(join(stage, 'package.json'), fixture.bytes.packageJson);
  await writeFile(join(stage, 'pnpm-lock.yaml'), fixture.bytes.pnpmLock);
  await writeFile(join(stage, 'pnpm-workspace.yaml'), fixture.bytes.pnpmWorkspace);
  return {
    fixture,
    plan,
    root,
    channelRoot,
    stage,
    receipt: preparedPackageReceipt(plan),
    target: preparedPackageTarget(channelRoot, plan),
    publish: () => publishPreparedPackage({ plan, stage, channelRoot }),
    reuse: () => readPreparedPackage(channelRoot, plan),
    mode: async (path: string) => (await stat(path)).mode & 0o777,
    readReceipt: async () =>
      readFile(join(preparedPackageTarget(channelRoot, plan), 'install-receipt.json'), 'utf8'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
