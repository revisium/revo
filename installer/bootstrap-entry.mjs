import { resolve } from 'node:path';
// oxlint-disable curly -- the entry keeps its direct-execution guard compact
import { pathToFileURL } from 'node:url';

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.env.REVO_BOOTSTRAP_ENTRY = '1';
  const { runBootstrap, runInstallMode } = await import('./node-bootstrap.mjs');
  if (process.env.REVO_INSTALL_MODE === 'pnpm')
    await runInstallMode({
      dataPath: process.argv[2],
      receiptPath: process.env.REVO_RECEIPT_PATH,
      target: process.env.REVO_NODE_TARGET,
      archiveSha256: process.env.REVO_NODE_ARCHIVE_SHA256,
      channelRoot: process.env.REVO_INSTALL_ROOT,
      privateNodeRoot: process.env.REVO_PRIVATE_NODE_ROOT,
      scratch: process.env.REVO_INSTALL_SCRATCH,
    });
  else
    await runBootstrap({
      dataPath: process.argv[2],
      receiptPath: process.env.REVO_RECEIPT_PATH,
      target: process.env.REVO_NODE_TARGET,
      archiveSha256: process.env.REVO_NODE_ARCHIVE_SHA256,
    });
}
