import { readdir, rmdir, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';

import {
  DEFAULT_CONTROL_SOCKET_ROOT,
  userDirectoryOf,
} from '../../src/processes/control-endpoint.directory.js';

const CONNECT_MILLISECONDS = 500;

/**
 * Tests start real servers and child processes whose control sockets live under the default
 * socket root. Whatever this run adds there is removed afterwards, so a run leaves no directories
 * in the real `/tmp/revo-<uid>`. Directories that existed before the run, and sockets that still
 * accept connections, are left alone.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return async () => undefined;
  }
  const userDirectory = userDirectoryOf(DEFAULT_CONTROL_SOCKET_ROOT, uid);
  const before = await entries(userDirectory);
  return async () => {
    const added = [...((await entries(userDirectory)) ?? [])].filter(
      (name) => before?.has(name) !== true,
    );
    await Promise.all(added.map((name) => removeScope(join(userDirectory, name))));
    if (before === undefined) {
      await rmdir(userDirectory).catch(() => undefined);
    }
  };
}

async function entries(directory: string): Promise<Set<string> | undefined> {
  try {
    return new Set(await readdir(directory));
  } catch {
    return undefined;
  }
}

async function removeScope(directory: string): Promise<void> {
  const sockets = [...((await entries(directory)) ?? [])].map((name) => join(directory, name));
  await Promise.all(
    sockets.map(async (path) => {
      if (await isStale(path)) {
        await unlink(path).catch(() => undefined);
      }
    }),
  );
  await rmdir(directory).catch(() => undefined);
}

function isStale(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const finish = (stale: boolean) => {
      socket.destroy();
      resolve(stale);
    };
    socket.setTimeout(CONNECT_MILLISECONDS, () => finish(false));
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
  });
}
