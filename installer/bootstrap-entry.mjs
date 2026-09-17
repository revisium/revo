import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
// oxlint-disable curly -- the entry keeps its direct-execution guard compact
import { fileURLToPath } from 'node:url';

import { parsePackageInstallPlan } from '../src/installation/package-install-plan.js';
import { acquireAndInstallPackage } from '../src/installation/package-install.js';
import { runPackageProcess } from '../src/installation/package-process.js';
import {
  publishPreparedPackage,
  readPreparedPackage,
} from '../src/installation/prepared-package.js';
import { InstallSession, installEnvironment } from './install-session.mjs';
import { publishNodeBootstrap, runBootstrap, runInstallMode } from './node-bootstrap.mjs';

const packageInstaller = (platform, arch) => {
  if (typeof REVO_PACKAGE_INSTALL_PLAN === 'undefined') return undefined;
  const plan = parsePackageInstallPlan({
    ...REVO_PACKAGE_INSTALL_PLAN,
    target: { platform, arch },
  });
  return async ({
    nodeExecutable,
    pnpmExecutable,
    nodeArchiveSha256,
    pnpmArchiveSha256,
    channelRoot,
    scratch,
    signal,
    progress,
    onProgress,
  }) => {
    const reused = await readPreparedPackage(channelRoot, plan);
    if (reused !== undefined) {
      onProgress?.('package-reuse');
      return {
        directory: reused,
        version: plan.release.version,
        plan,
        nodeArchiveSha256,
        pnpmArchiveSha256,
        reused: true,
      };
    }
    const installed = await acquireAndInstallPackage({
      plan,
      nodeArchiveSha256,
      pnpmArchiveSha256,
      scratch,
      pnpmExecutable,
      nodeExecutable,
      ...(signal === undefined ? {} : { signal }),
      ...(progress === undefined ? {} : { progress }),
      ...(onProgress === undefined
        ? {}
        : {
            onProgress: (stage) =>
              onProgress(stage === 'dependencies' ? stage : `package-${stage}`),
          }),
    });
    const published = await publishPreparedPackage({
      plan,
      stage: installed.directory,
      channelRoot,
    });
    return {
      ...published,
      version: plan.release.version,
      plan,
      nodeArchiveSha256,
      pnpmArchiveSha256,
      reused: false,
    };
  };
};

const activatePrepared = async ({
  packageResult,
  nodeExecutable,
  channelRoot,
  scratch,
  signal,
}) => {
  const helper = resolve(packageResult.directory, 'dist/bin/revo-install-activate.js');
  const requestDirectory = await mkdtemp(resolve(scratch, '.activation-request-'));
  const requestPath = resolve(requestDirectory, 'request.json');
  const diagnosticPath = resolve(requestDirectory, 'result.log');
  let confirmed = false;
  try {
    await writeFile(
      requestPath,
      `${JSON.stringify({
        schemaVersion: 'revo-install-activate/v1',
        channelRoot,
        packagePlan: packageResult.plan,
        nodeArchiveSha256: packageResult.nodeArchiveSha256,
        pnpmArchiveSha256: packageResult.pnpmArchiveSha256,
      })}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    const result = await runPackageProcess({
      executable: nodeExecutable,
      args: [helper, requestPath],
      cwd: packageResult.directory,
      env: installEnvironment(nodeExecutable, packageResult.plan.release.channel),
      diagnosticPath,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.exitCode !== 0 || result.signal !== null)
      throw Object.assign(new Error('ACTIVATION_UNCONFIRMED'), { diagnosticPath });
    let validResult = false;
    let receipt;
    try {
      const parsed = JSON.parse(result.stdout);
      receipt = parsed;
      validResult =
        parsed?.schemaVersion === 'revo-install-activate/v1' &&
        Object.keys(parsed).length === 3 &&
        (parsed.status === 'activated' || parsed.status === 'unchanged') &&
        typeof parsed.generationId === 'string' &&
        /^[a-f0-9]{64}$/u.test(parsed.generationId);
    } catch {}
    if (!validResult) throw Object.assign(new Error('ACTIVATION_UNCONFIRMED'), { diagnosticPath });
    confirmed = true;
    return receipt;
  } finally {
    if (confirmed) await rm(requestDirectory, { recursive: true, force: true });
  }
};

if (
  process.argv[1] !== undefined &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.env.REVO_BOOTSTRAP_ENTRY = '1';
  const controller = new AbortController();
  const managedMode =
    process.env.REVO_INSTALL_MODE === 'node' || process.env.REVO_INSTALL_MODE === 'pnpm';
  const session = managedMode ? new InstallSession() : undefined;
  if (session !== undefined) {
    // Keep handlers for the lifetime of the entry: write errors can arrive after finish().
    process.stdout.on('error', () => {
      session.markOutputFailed('stdout');
      process.exitCode = 1;
    });
    process.stderr.on('error', () => {
      session.markOutputFailed('stderr');
      process.exitCode = 1;
    });
  }
  const abort = () => controller.abort();
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, abort);
  try {
    if (process.env.REVO_INSTALL_MODE === 'node') {
      const decoded = await runBootstrap({
        dataPath: process.argv[2],
        receiptPath: process.env.REVO_RECEIPT_PATH,
        target: process.env.REVO_NODE_TARGET,
        archiveSha256: process.env.REVO_NODE_ARCHIVE_SHA256,
      });
      await publishNodeBootstrap({
        bootstrap: decoded,
        stage: process.env.REVO_NODE_STAGE,
        channelRoot: process.env.REVO_INSTALL_ROOT,
        platform: process.env.REVO_PLATFORM,
        arch: process.env.REVO_ARCH,
        signal: controller.signal,
        onProgress: session.stage,
      });
    } else if (process.env.REVO_INSTALL_MODE === 'pnpm')
      await runInstallMode({
        dataPath: process.argv[2],
        receiptPath: process.env.REVO_RECEIPT_PATH,
        target: process.env.REVO_NODE_TARGET,
        archiveSha256: process.env.REVO_NODE_ARCHIVE_SHA256,
        channelRoot: process.env.REVO_INSTALL_ROOT,
        privateNodeRoot: process.env.REVO_PRIVATE_NODE_ROOT,
        scratch: process.env.REVO_INSTALL_SCRATCH,
        signal: controller.signal,
        packageInstaller: packageInstaller(
          process.env.REVO_PLATFORM,
          process.env.REVO_ARCH,
          REVO_PACKAGE_INSTALL_PLAN,
        ),
        activatePackage: activatePrepared,
        startPackage: session.start,
        onProgress: session.stage,
        packageProgress: session.packageProgress,
      });
    else
      await runBootstrap({
        dataPath: process.argv[2],
        receiptPath: process.env.REVO_RECEIPT_PATH,
        target: process.env.REVO_NODE_TARGET,
        archiveSha256: process.env.REVO_NODE_ARCHIVE_SHA256,
      });
    if (session !== undefined) {
      await session.finish();
    }
  } catch (error) {
    if (session === undefined) {
      throw error;
    }
    process.exitCode = 1;
    await session.fail(process.env.REVO_INSTALL_SCRATCH, error);
  } finally {
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.removeListener(signal, abort);
  }
}
