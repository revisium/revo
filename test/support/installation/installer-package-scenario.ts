import { fork } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  await mkdir(channelRoot, { recursive: true, mode: 0o700 });
  await mkdir(stage, { recursive: true, mode: 0o700 });
  await mkdir(join(stage, 'node_modules'), { recursive: true, mode: 0o700 });
  await writeFile(join(stage, 'package.json'), fixture.bytes.packageJson, { mode: 0o600 });
  await writeFile(join(stage, 'pnpm-lock.yaml'), fixture.bytes.pnpmLock, { mode: 0o600 });
  await writeFile(join(stage, 'pnpm-workspace.yaml'), fixture.bytes.pnpmWorkspace, {
    mode: 0o600,
  });
  const prepareAttempt = async (label: string, options: { invalid?: boolean } = {}) => {
    const attempt = join(root, `attempt-${label}`);
    await mkdir(join(attempt, 'node_modules'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(attempt, 'package.json'),
      options.invalid ? '{"name":"foreign"}\n' : fixture.bytes.packageJson,
      { mode: 0o600 },
    );
    if (!options.invalid) {
      await writeFile(join(attempt, 'pnpm-lock.yaml'), fixture.bytes.pnpmLock, { mode: 0o600 });
      await writeFile(join(attempt, 'pnpm-workspace.yaml'), fixture.bytes.pnpmWorkspace, {
        mode: 0o600,
      });
    }
    return { stage: attempt };
  };
  return {
    fixture,
    plan,
    root,
    channelRoot,
    stage,
    receipt: preparedPackageReceipt(plan),
    target: preparedPackageTarget(channelRoot, plan),
    publish: () => publishPreparedPackage({ plan, stage, channelRoot }),
    prepareAttempt,
    publishAttempt: (attempt: { stage: string }) =>
      publishPreparedPackage({ plan, stage: attempt.stage, channelRoot }),
    publishTogether: async (attempts: readonly { stage: string }[]) => {
      const script = fileURLToPath(new URL('./prepared-package-process.mjs', import.meta.url));
      const children = attempts.map(() =>
        fork(script, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
      );
      await Promise.all(
        children.map((child) => new Promise<void>((resolve) => child.once('message', resolve))),
      );
      const outcomes = children.map((child, index) => {
        const attempt = attempts[index];
        if (attempt === undefined) {
          throw new Error('publisher attempt is missing');
        }
        return new Promise<{ readonly ok: boolean; readonly directory?: string }>((resolve) => {
          child.once('message', (message: { ok: boolean; directory?: string }) => resolve(message));
          child.send({ plan, stage: attempt.stage, channelRoot });
        });
      });
      return Promise.all(outcomes);
    },
    publishCompetitorBeforeCommit: async ({ corrupt = false } = {}) => {
      await mkdir(
        join(
          channelRoot,
          'package',
          plan.release.version,
          `${plan.target.platform}-${plan.target.arch}`,
        ),
        {
          recursive: true,
          mode: 0o700,
        },
      );
      if (!corrupt) {
        return;
      }
      await writeFile(
        join(preparedPackageTarget(channelRoot, plan), 'package.json'),
        '{"name":"foreign"}\n',
        { mode: 0o600 },
      );
    },
    readPublishedPackage: () => readPreparedPackage(channelRoot, plan),
    inspectAttempt: async (attempt: { stage: string }) =>
      (await lstat(attempt.stage).catch(() => undefined)) !== undefined,
    snapshotWinner: () =>
      readFile(join(preparedPackageTarget(channelRoot, plan), 'package.json'), 'utf8').then(
        (value) => JSON.parse(value).name,
      ),
    reuse: () => readPreparedPackage(channelRoot, plan),
    mode: async (path: string) => (await stat(path)).mode & 0o777,
    readReceipt: async () =>
      readFile(join(preparedPackageTarget(channelRoot, plan), 'install-receipt.json'), 'utf8'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
