import { describe, expect, it } from 'vitest';

import {
  decodeTokenProbe,
  decodeTokenProbeCommandResult,
  parseTokenProbe,
  requireExpectedProfile,
  requireExpectedSid,
  runTokenProbeCommand,
  type WindowsTokenProbe,
} from '../support/process/windows-process-identity-scenario.js';

const validProbe: WindowsTokenProbe = {
  schemaVersion: 1,
  inspectedPid: 42,
  sid: 'S-1-5-21-1-2-3-1001',
  isElevated: false,
  elevationType: 1,
  hasAdministratorsSid: false,
  integritySid: 'S-1-16-8192',
  profileHiveLoaded: true,
  profileMatchesExpected: true,
};

const failedProbeResults = [
  { error: new Error('SECRET_RAW'), status: null, signal: null, stdout: '', stderr: '' },
  { status: 1, signal: null, stdout: 'SECRET_RAW', stderr: '' },
  { status: null, signal: 'SIGTERM', stdout: '', stderr: '' },
  { status: 0, signal: null, stdout: JSON.stringify(validProbe), stderr: 'SECRET_RAW' },
  { status: 0, signal: null, stdout: 'SECRET_RAW', stderr: '' },
] as const;

describe('Windows process identity evidence boundary', () => {
  it('accepts canonical local user SIDs and rejects missing components', () => {
    expect(requireExpectedSid('S-1-5-21-1-2-3-1001')).toBe('S-1-5-21-1-2-3-1001');
    expect(() => requireExpectedSid(undefined)).toThrow('WINDOWS_EXPECTED_SID_INVALID');
    expect(() => requireExpectedSid('S-1-5-21-1-2-3')).toThrow('WINDOWS_EXPECTED_SID_INVALID');
  });

  it('requires the independently provisioned profile anchor to be absolute', () => {
    expect(requireExpectedProfile('C:\\Users\\revo-test')).toBe('C:\\Users\\revo-test');
    expect(() => requireExpectedProfile('relative-profile')).toThrow(
      'WINDOWS_EXPECTED_PROFILE_INVALID',
    );
    expect(() => requireExpectedProfile(undefined)).toThrow('WINDOWS_EXPECTED_PROFILE_INVALID');
  });

  it('decodes a complete native token report without changing its values', () => {
    expect(decodeTokenProbe(validProbe)).toEqual(validProbe);
    expect(parseTokenProbe(JSON.stringify(validProbe))).toEqual(validProbe);
  });

  it('rejects malformed JSON, null, arrays, and missing or extra fields', () => {
    expect(() => parseTokenProbe('{')).toThrow('WINDOWS_TOKEN_PROBE_INVALID');
    expect(() => parseTokenProbe('null')).toThrow('WINDOWS_TOKEN_PROBE_INVALID');
    expect(() => decodeTokenProbe(null)).toThrow('WINDOWS_TOKEN_PROBE_INVALID');
    expect(() => decodeTokenProbe([])).toThrow('WINDOWS_TOKEN_PROBE_INVALID');

    const missing: Record<string, unknown> = { ...validProbe };
    delete missing.sid;
    expect(() => decodeTokenProbe(missing)).toThrow('WINDOWS_TOKEN_PROBE_INVALID');
    expect(() => decodeTokenProbe({ ...validProbe, unexpected: true })).toThrow(
      'WINDOWS_TOKEN_PROBE_INVALID',
    );
  });

  it('rejects wrong field types and accepts well-formed administrative observations for semantic assertions', () => {
    expect(() => decodeTokenProbe({ ...validProbe, isElevated: 'false' })).toThrow(
      'WINDOWS_TOKEN_PROBE_INVALID',
    );
    expect(() => decodeTokenProbe({ ...validProbe, inspectedPid: '42' })).toThrow(
      'WINDOWS_TOKEN_PROBE_INVALID',
    );

    const administrator = {
      ...validProbe,
      isElevated: true,
      elevationType: 2,
      hasAdministratorsSid: true,
      integritySid: 'S-1-16-12288',
    };
    expect(decodeTokenProbe(administrator)).toEqual(administrator);
  });

  it('accepts only a clean successful probe process result', () => {
    expect(
      decodeTokenProbeCommandResult({
        status: 0,
        signal: null,
        stdout: JSON.stringify(validProbe),
        stderr: '',
      }),
    ).toEqual(validProbe);
  });

  it.each(failedProbeResults)(
    'rejects failed probe result %# without exposing output',
    (result) => {
      expect(() => decodeTokenProbeCommandResult(result)).toThrow(/^WINDOWS_TOKEN_PROBE_FAILED$/u);
    },
  );

  it('normalizes synchronous spawn exceptions without exposing them', () => {
    expect(() =>
      runTokenProbeCommand(() => {
        throw new Error('SECRET_RAW');
      }),
    ).toThrow(/^WINDOWS_TOKEN_PROBE_FAILED$/u);
  });
});
