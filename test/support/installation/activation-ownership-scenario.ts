import { chmod } from 'node:fs/promises';

import {
  acquireActivationOwnership,
  type ActivationOwnership,
} from '../../../src/installation/activation-ownership.js';
import { readActivation } from '../../../src/installation/activation-store.js';
import { activationScenario } from './activation-scenario.js';

export async function activationOwnershipScenario() {
  const prepared = await activationScenario();
  await chmod(prepared.channelRoot, 0o700);

  const acquire = (): Promise<ActivationOwnership> =>
    acquireActivationOwnership({ channelRoot: prepared.channelRoot, channel: 'stable' });
  const activateOwned = async () => {
    const first = await acquire();
    if (first.status !== 'held') {
      throw new Error('first ownership was not acquired');
    }
    try {
      const expectedCurrent = await readActivation(prepared.channelRoot);
      return await prepared.activate({ lease: first.lease, expectedCurrent });
    } finally {
      await first.lease.release();
    }
  };
  const reacquire = async () => {
    const second = await acquire();
    if (second.status !== 'held') {
      throw new Error('ownership was not reacquired');
    }
    await second.lease.assertHeld();
    await second.lease.release();
  };
  return { ...prepared, acquire, activateOwned, reacquire };
}
