import { parsePackageInstallPlan } from '../../../src/installation/package-install-plan.js';
import { acquireAndInstallPackage } from '../../../src/installation/package-install.js';
import {
  publishPreparedPackage,
  readPreparedPackage,
} from '../../../src/installation/prepared-package.js';

export const packageInstaller = (platform, arch) => {
  if (typeof REVO_PACKAGE_INSTALL_PLAN === 'undefined') {
    return undefined;
  }
  const plan = parsePackageInstallPlan({
    ...REVO_PACKAGE_INSTALL_PLAN,
    target: { platform, arch },
  });
  return async (input) => {
    const reused = await readPreparedPackage(input.channelRoot, plan);
    if (reused !== undefined) {
      return { directory: reused, version: plan.release.version, plan, ...input, reused: true };
    }
    const installed = await acquireAndInstallPackage({ ...input, plan });
    const published = await publishPreparedPackage({
      plan,
      stage: installed.directory,
      channelRoot: input.channelRoot,
    });
    return { ...published, version: plan.release.version, plan, reused: false };
  };
};
