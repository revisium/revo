import { constants, open } from 'node:fs/promises';

/** Makes renames and new entries in a directory durable across a power loss. */
export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
