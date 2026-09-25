import { afterEach, describe, expect, it } from 'vitest';

import { PostgresScenario } from '../support/postgres/postgres-scenario.js';

describe('embedded PostgreSQL provision', () => {
  let scenario = new PostgresScenario();
  afterEach(async () => {
    await scenario.cleanup();
    scenario = new PostgresScenario();
  }, 35_000);

  it('hydrates public binaries, initializes PostgreSQL 17 once, and safely reopens it', async () => {
    await expect(scenario.provisionAndReopen()).resolves.toEqual({
      samePromiseResult: true,
      created: true,
      reopened: false,
      passwordPreserved: true,
      passwordMode: 0o600,
      version: '17\n',
      frozen: true,
    });
  }, 150_000);

  it.each(['fifo', 'partial', 'symlink'] as const)(
    'rejects an existing %s cluster without replacing it',
    async (kind) => {
      await expect(scenario.rejectsUnsafeExistingState(kind)).resolves.toBe('rejected');
    },
  );

  it.each(['malformed-credential', 'public-credential', 'wrong-major'] as const)(
    'rejects an existing %s cluster without replacing it',
    async (kind) => {
      await expect(scenario.rejectsUnsafeExistingState(kind)).resolves.toBe('rejected');
    },
    90_000,
  );

  it('cancels and drains owned initialization before releasing ownership', async () => {
    await expect(scenario.closeCancelsOwnedInitialization()).resolves.toEqual({
      firstClose: {
        status: 'rejected',
        code: 'PUBLISHED_CONTROL_ERROR',
        ownership: 'retained',
      },
      secondClose: 'rejected',
      outcome: 'rejected',
      coalesced: true,
      busy: 'busy',
      beforeDrain: 'busy',
      beforeDrainClose: {
        status: 'rejected',
        code: 'PUBLISHED_CONTROL_ERROR',
        ownership: 'retained',
      },
      replacement: 'held',
      oldClose: 'resolved',
      successorStillHeld: 'busy',
      retained: [true, true],
      secretByPathOnly: true,
      environment: { LC_ALL: 'C' },
    });
  });

  it('preserves an observed initdb exit through a progress failure', async () => {
    await expect(
      scenario.preservesObservedInitializationExitWhenProgressFailureRewraps(),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: 'process',
      progressFailure: true,
      observedCompletion: { exitCode: 7, signal: null },
    });
  });
});
