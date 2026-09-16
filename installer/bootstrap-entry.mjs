import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
// oxlint-disable curly -- the entry keeps its direct-execution guard compact
import { fileURLToPath } from 'node:url';

import { parsePackageInstallPlan } from '../src/installation/package-install-plan.js';
import { acquireAndInstallPackage } from '../src/installation/package-install.js';
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
  return async ({ nodeExecutable, pnpmExecutable, channelRoot, scratch, signal, progress }) => {
    const reused = await readPreparedPackage(channelRoot, plan);
    if (reused !== undefined) return { directory: reused, reused: true };
    const installed = await acquireAndInstallPackage({
      plan,
      scratch,
      pnpmExecutable,
      nodeExecutable,
      ...(signal === undefined ? {} : { signal }),
      ...(progress === undefined ? {} : { progress }),
    });
    return {
      ...(await publishPreparedPackage({ plan, stage: installed.directory, channelRoot })),
      reused: false,
    };
  };
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
