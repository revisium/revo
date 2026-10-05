import { mkdtemp, rm } from 'node:fs/promises';

/**
 * Every test worker and child process shares one private control socket root, so a run never
 * touches the real `/tmp/revo-<uid>`. The root is short to stay within the socket path limit.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const root = await mkdtemp('/tmp/revo-t-');
  process.env.REVO_CONTROL_SOCKET_ROOT = root;
  return async () => {
    await rm(root, { recursive: true, force: true });
  };
}
