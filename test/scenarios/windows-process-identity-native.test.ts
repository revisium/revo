import { describe, expect, it } from 'vitest';

import {
  requireExpectedProfile,
  requireExpectedSid,
  WindowsProcessIdentityScenario,
} from '../support/process/windows-process-identity-scenario.js';

describe('native Windows process identity', () => {
  it.skipIf(process.platform !== 'win32')(
    'captures the current standard-user process through Nest',
    async () => {
      const expectedSid = requireExpectedSid(process.env.REVO_EXPECTED_SID);
      requireExpectedProfile(process.env.REVO_EXPECTED_PROFILE);

      const scenario = new WindowsProcessIdentityScenario();
      const token = scenario.inspectCurrentProcessToken();
      expect(token.inspectedPid).toBe(process.pid);
      expect(token.sid).toBe(expectedSid);
      expect(token.isElevated).toBe(false);
      expect(token.hasAdministratorsSid).toBe(false);
      expect(token.elevationType).toBe(1);
      expect(token.integritySid).toBe('S-1-16-8192');
      expect(token.profileHiveLoaded).toBe(true);
      expect(token.profileMatchesExpected).toBe(true);

      const result = await scenario.capturesCurrentProcessThroughNest();
      expect(result.identity).toMatchObject({
        platform: 'win32',
        pid: process.pid,
        sid: expectedSid,
      });
      expect(result.inspection).toEqual({ kind: 'confirmed' });
    },
    30_000,
  );
});
