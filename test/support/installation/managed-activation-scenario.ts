import { chmod, mkdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ConfigurationInput } from '../../../src/configuration/configuration.types.js';
import {
  acquireActivationOwnership,
  type ActivationOwnership,
} from '../../../src/installation/activation-ownership.js';
import type { ActivationCandidate } from '../../../src/installation/activation-store.js';
import { ManagedActivationService } from '../../../src/installation/managed-activation.service.js';
import { ServerOwnershipService } from '../../../src/processes/server-ownership.service.js';
import { activationScenario } from './activation-scenario.js';

type Channel = 'stable' | 'alpha';

function configuration(root: string, channel: Channel, dataDir: string): ConfigurationInput {
  return {
    env: {},
    flags: { dataDir },
    homeDir: root,
    packageVersion: channel === 'alpha' ? '1.2.3-alpha.1' : '1.2.3',
    platform: process.platform === 'darwin' ? 'darwin' : 'linux',
    wrapperChannel: channel,
  };
}

export async function managedActivationScenario(
  options: {
    readonly acquireOwnership?: typeof acquireActivationOwnership;
    readonly server?: ServerOwnershipService;
    readonly dataDir?: string;
  } = {},
) {
  const data = await activationScenario();
  const service = new ManagedActivationService(undefined, options.server, options.acquireOwnership);
  const stableData = options.dataDir ?? join(data.root, 'server-data');
  const alphaData = join(data.root, 'alpha-data');
  await mkdir(stableData, { mode: 0o700, recursive: true });
  await mkdir(alphaData, { mode: 0o700 });
  await chmod(data.channelRoot, 0o700);

  const activate = (candidate: ActivationCandidate = data.first, signal?: AbortSignal) =>
    service.activate({
      channelRoot: data.channelRoot,
      candidate,
      configuration: configuration(data.root, 'stable', stableData),
      ...(signal === undefined ? {} : { signal }),
    });
  const holdServer = () => new ServerOwnershipService().acquire(stableData);
  return {
    ...data,
    stableData,
    configuration: () => configuration(data.root, 'stable', stableData),
    activate,
    activateNext: () => activate(data.next),
    activateNextRaw: data.activateNext,
    holdServer,
    pointer: () => readlink(data.currentPath),
    userData: () => readFile(data.userData, 'utf8'),
    dataExists: async () => Boolean(await stat(stableData).catch(() => undefined)),
    alphaDataExists: async () => Boolean(await stat(alphaData).catch(() => undefined)),
    setPackageBinMode: (mode: number) => data.setPackageBinMode(mode),
    corruptPointer: async () => {
      await rm(data.currentPath);
      await writeFile(data.currentPath, 'corrupt');
    },
    replaceDataDirectory: async () => {
      await rm(stableData, { recursive: true });
      await writeFile(stableData, 'not a directory');
    },
    restoreDataDirectory: async () => {
      await rm(stableData);
      await mkdir(stableData, { mode: 0o700 });
    },
    release: () => data.cleanup(),
  };
}

export type ManagedOwnership = Extract<ActivationOwnership, { status: 'held' }>;
