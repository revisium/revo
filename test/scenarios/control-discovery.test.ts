import { afterEach, describe, expect, it } from 'vitest';

import { PublishedControlScenario } from '../support/process/published-control-scenario.js';

describe('owned control publication and discovery', () => {
  let scenario = new PublishedControlScenario();
  afterEach(async () => {
    await scenario.cleanup();
    scenario = new PublishedControlScenario();
  });

  it('publishes from a different process before discovery and rejects a second owner', async () => {
    await expect(scenario.publishesFromDifferentProcess()).resolves.toEqual({
      discovery: 'found',
      probe: { kind: 'confirmed' },
      busy: 'busy',
    });
  });

  it('publishes a probeable record and prevents a second owner', async () => {
    await expect(scenario.publishesAndPreventsSecondOwner()).resolves.toEqual({
      held: 'held',
      discovery: 'found',
      probe: { kind: 'confirmed' },
      busy: 'busy',
    });
  });
  it('records canonical data identity separately from runtime', async () => {
    const result = await scenario.publishesCanonicalAlias();
    expect(result).toEqual({
      canonical: result.dataDir,
      dataDir: result.dataDir,
      separateRuntime: true,
    });
  });
  it('releases ownership after publication failure', async () => {
    await expect(scenario.releasesAfterPublicationFailure()).resolves.toEqual({
      failure: 'rejected',
      retry: 'held',
    });
  });
  it('does not let repeated old close delete replacement metadata', async () => {
    await expect(scenario.oldCloseCannotDeleteReplacement()).resolves.toBe(true);
  });
  it('replaces stale metadata after its crashed owner releases the kernel lock', async () => {
    await expect(scenario.replacesCrashStaleRecord()).resolves.toEqual({
      replacement: 'held',
      changed: true,
    });
  });
  it('classifies missing and unsafe locator states', async () => {
    await expect(scenario.readsUnsafeMetadata()).resolves.toEqual([
      'missing',
      'invalid',
      'invalid',
      'unavailable',
      'invalid',
      'invalid',
      'unavailable',
    ]);
  });
  it('reads a FIFO without blocking and releases ownership after invalid cleanup state', async () => {
    await expect(scenario.invalidFifoCloseStillReleasesOwnership()).resolves.toEqual({
      invalid: 'invalid',
      close: 'rejected',
      replacement: 'held',
    });
  });
  it('rejects oversized publication and reports safe startup cleanup outcomes', async () => {
    const result = await scenario.rejectsOversizedPublicationAndReportsCleanupFailure();
    expect(result).toMatchObject({
      oversized: 'rejected',
      retry: 'held',
      cleanup: {
        code: 'PUBLISHED_CONTROL_ERROR',
        phase: 'startup',
        cleanupFailures: ['ownership'],
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret release failure');
  });
});
