import { open, readFile } from 'node:fs/promises';

const dataPath = process.argv[2];
const receiptPath = process.env.REVO_RECEIPT_PATH;
const target = process.env.REVO_NODE_TARGET;
const archiveSha256 = process.env.REVO_NODE_ARCHIVE_SHA256;
if (!dataPath || !receiptPath || !target || !archiveSha256) {
  throw new Error('Node bootstrap input is incomplete.');
}
const bootstrap = JSON.parse(await readFile(dataPath, 'utf8'));
if (
  typeof bootstrap !== 'object' ||
  bootstrap === null ||
  bootstrap.nodeVersion !== process.versions.node ||
  !Array.isArray(bootstrap.archives) ||
  !bootstrap.archives.some(
    (archive) =>
      archive &&
      `${archive.platform}-${archive.arch}` === target &&
      archive.sha256 === archiveSha256,
  )
) {
  throw new Error('Node bootstrap data does not match the staged runtime.');
}
const receipt = `${JSON.stringify({ version: bootstrap.nodeVersion, target, archiveSha256 })}\n`;
const file = await open(receiptPath, 'wx', 0o600);
try {
  await file.writeFile(receipt, 'utf8');
} finally {
  await file.close();
}
