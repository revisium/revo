import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ChildResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

export async function pnpmBootstrapScenario(enginePath: string, bootstrap: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'revo-bootstrap-data-'));
  const dataPath = join(root, 'bootstrap.json');
  const receiptPath = join(root, 'install-receipt.json');
  const write = (value: unknown) =>
    writeFile(dataPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await write(bootstrap);
  const runDirect = (target: string, archiveSha256: string) =>
    new Promise<ChildResult>((done) => {
      const child = spawn(process.execPath, [enginePath, dataPath], {
        env: {
          ...process.env,
          REVO_NODE_TARGET: target,
          REVO_NODE_ARCHIVE_SHA256: archiveSha256,
          REVO_RECEIPT_PATH: receiptPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.once('close', (code, signal) => done({ code, signal, stdout, stderr }));
    });
  return {
    dataPath,
    receiptPath,
    write,
    receipt: async () => readFile(receiptPath, 'utf8').catch(() => undefined),
    receiptMode: async () =>
      stat(receiptPath)
        .then((info) => info.mode & 0o777)
        .catch(() => undefined),
    runDirect,
  };
}
