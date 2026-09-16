import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  }) => {
    const reused = await readPreparedPackage(channelRoot, plan);
    if (reused !== undefined)
      return {
        directory: reused,
        version: plan.release.version,
        plan,
        nodeArchiveSha256,
        pnpmArchiveSha256,
        reused: true,
      };
    const installed = await acquireAndInstallPackage({
      plan,
      nodeArchiveSha256,
      pnpmArchiveSha256,
      scratch,
      pnpmExecutable,
      nodeExecutable,
      ...(signal === undefined ? {} : { signal }),
      ...(progress === undefined ? {} : { progress }),
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

const packageBin = async (directory) => {
  const value = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const bin = typeof value.bin === 'string' ? value.bin : value.bin?.revo;
  if (typeof bin !== 'string' || bin.startsWith('/') || bin.includes('..'))
    throw new Error('package bin is invalid');
  return bin;
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
      env: {
        PATH: `${resolve(nodeExecutable, '..')}:/usr/bin:/bin`,
        NODE_PATH: '',
        ...Object.fromEntries(
          ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'REVO_CONFIG', 'REVO_CHANNEL', 'REVO_DATABASE_URL', 'REVO_DATA_DIR', 'REVO_HOST', 'REVO_LOG_DIR', 'REVO_PORT', 'REVO_PUBLIC_URL', 'REVO_STARTUP_TIMEOUT']
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key]]),
        ),
      },
      diagnosticPath,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.exitCode !== 0 || result.signal !== null)
      throw new Error('activation helper failed');
    let validResult = false;
    try {
      const parsed = JSON.parse(result.stdout);
      validResult =
        parsed?.schemaVersion === 'revo-install-activate/v1' &&
        (parsed.status === 'activated' || parsed.status === 'unchanged') &&
        typeof parsed.generationId === 'string' &&
        /^[a-f0-9]{64}$/u.test(parsed.generationId);
    } catch {}
    if (!validResult) throw new Error('activation helper result is invalid');
    confirmed = true;
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
  const abort = () => controller.abort();
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.once(signal, abort);
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
        packageInstaller: packageInstaller(process.env.REVO_PLATFORM, process.env.REVO_ARCH),
        activatePackage: activatePrepared,
      });
    else
      await runBootstrap({
        dataPath: process.argv[2],
        receiptPath: process.env.REVO_RECEIPT_PATH,
        target: process.env.REVO_NODE_TARGET,
        archiveSha256: process.env.REVO_NODE_ARCHIVE_SHA256,
      });
  } finally {
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.removeListener(signal, abort);
  }
}
