import { writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , mode, ...args] = process.argv;

if (mode === 'child') {
  const [root] = args;
  process.on('SIGTERM', () => {
    void writeFile(join(root, 'signal-observed'), 'SIGTERM');
  });
  process.on('message', (message) => {
    if (message?.action === 'begin') {
      process.send?.({ pid: process.pid });
    }
  });
  await waitFor(join(root, 'cleanup'));
  await writeFile(join(root, 'child-completed'), 'completed');
} else {
  const [transition, root] = [mode, ...args];
  const { ManagedProcessService } =
    await import('../../../dist/processes/managed-process.service.js');
  const cancellation = new AbortController();
  const service = new ManagedProcessService();
  const child = await service.start({
    args: [fileURLToPath(import.meta.url), 'child', root],
    cancellation: { graceMs: 20, killWaitMs: 1_000, signal: cancellation.signal },
    cwd: dirname(fileURLToPath(import.meta.url)),
    detached: true,
    env: {},
    executable: process.execPath,
    ipc: true,
    stdio: { stderr: 'ignore', stdin: 'ignore', stdout: 'ignore' },
  });
  const identity = new Promise((resolve) => {
    const unsubscribe = child.subscribe?.((message) => {
      unsubscribe?.();
      resolve(message);
    });
  });
  await child.send?.({ action: 'begin' });
  const { pid } = await identity;
  await writeFile(join(root, 'released-child.pid'), String(pid));
  await child[transition]();
  cancellation.abort();
  await child.cancellationResult;
  process.stdout.write(`${JSON.stringify({ pid })}\n`);
}

async function waitFor(path) {
  if (
    await stat(path).then(
      () => true,
      () => false,
    )
  ) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  await waitFor(path);
}
