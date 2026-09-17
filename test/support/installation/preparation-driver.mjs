import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  publishNodeBootstrap,
  runBootstrap,
  runInstallMode,
} from '../../../installer/node-bootstrap.mjs';
import { packageInstaller } from './preparation-package-installer.mjs';

const values = {
  dataPath: process.argv[2],
  receiptPath: process.env.REVO_RECEIPT_PATH,
  target: process.env.REVO_NODE_TARGET,
  archiveSha256: process.env.REVO_NODE_ARCHIVE_SHA256,
  channelRoot: process.env.REVO_INSTALL_ROOT,
  privateNodeRoot: process.env.REVO_PRIVATE_NODE_ROOT,
  scratch: process.env.REVO_INSTALL_SCRATCH,
};
if (process.env.REVO_INSTALL_MODE === 'node') {
  await mkdir(dirname(values.receiptPath), { recursive: true });
  const bootstrap = await runBootstrap(values);
  await publishNodeBootstrap({
    bootstrap,
    stage: process.env.REVO_NODE_STAGE,
    channelRoot: process.env.REVO_INSTALL_ROOT,
    platform: process.env.REVO_PLATFORM,
    arch: process.env.REVO_ARCH,
  });
} else {
  if (Object.values(values).some((value) => typeof value !== 'string')) {
    throw new Error(
      `preparation driver input incomplete: ${Object.keys(values)
        .filter((key) => typeof values[key] !== 'string')
        .join(',')}`,
    );
  }
  await runInstallMode({
    ...values,
    packageInstaller: packageInstaller(process.env.REVO_PLATFORM, process.env.REVO_ARCH),
  });
}
