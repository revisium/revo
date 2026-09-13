import { afterEach, describe, expect, it } from 'vitest';

import { ProcessIdentityScenario } from '../support/process/process-identity-scenario.js';

describe('process identity', () => {
  let scenario = new ProcessIdentityScenario();
  afterEach(async () => {
    await scenario.cleanup();
    scenario = new ProcessIdentityScenario();
  });

  it('captures through Nest and distinguishes changed or invalid records', async () => {
    const identity = await scenario.capturesCurrentProcessThroughNest();
    expect(identity).toMatchObject({
      platform: process.platform,
      pid: process.pid,
      uid: process.getuid?.(),
    });
    await expect(scenario.rejectsChangedAndInvalidRecords(identity)).resolves.toEqual([
      { kind: 'mismatch' },
      { kind: 'mismatch' },
      { kind: 'unknown', reason: 'invalid-record' },
    ]);
  });
  it('captures a live child and reports it missing only after exit', async () => {
    const result = await scenario.capturesChildAndObservesExit();
    expect(result).toMatchObject({
      whileRunning: { kind: 'confirmed' },
      afterExit: { kind: 'missing' },
      nativeBirthValid: true,
    });
  });
  it('parses Linux comm delimiters and uint64 ticks without precision loss', async () => {
    await expect(scenario.provesLinuxParsing()).resolves.toMatchObject({
      birth: { startTicks: '18446744073709551614' },
    });
  });
  it('treats an inconsistent Linux uid snapshot as unknown', async () => {
    await expect(scenario.provesMalformedLinuxIsUnknown()).resolves.toEqual({
      kind: 'unknown',
      reason: 'malformed',
    });
  });
  it('rejects proc stat content for a different pid', async () => {
    await expect(scenario.provesMismatchedLinuxPidIsUnknown()).resolves.toEqual({
      kind: 'unknown',
      reason: 'unstable',
    });
  });
  it('rejects noncanonical proc stat pid prefixes', async () => {
    await expect(scenario.provesMalformedLinuxPidPrefixesAreUnknown()).resolves.toEqual([
      { kind: 'unknown', reason: 'malformed' },
      { kind: 'unknown', reason: 'malformed' },
      { kind: 'unknown', reason: 'malformed' },
    ]);
  });
  it('decodes the Darwin ABI exactly and rejects partial results', async () => {
    await expect(scenario.provesDarwinBoundary()).resolves.toMatchObject({
      complete: {
        kind: 'captured',
        identity: { birth: { seconds: '9007199254740993', microseconds: '42' } },
      },
      partial: { kind: 'unknown', reason: 'malformed' },
      failed: { kind: 'unknown', reason: 'unavailable' },
    });
  });
});
