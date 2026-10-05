import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { win32 } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { ProcessIdentityService } from '../../../src/processes/process-identity.service.js';
import { ProcessesModule } from '../../../src/processes/processes.module.js';

export interface WindowsTokenProbe {
  readonly schemaVersion: 1;
  readonly inspectedPid: number;
  readonly sid: string;
  readonly isElevated: boolean;
  readonly elevationType: number;
  readonly hasAdministratorsSid: boolean;
  readonly integritySid: string;
  readonly profileHiveLoaded: boolean;
  readonly profileMatchesExpected: boolean;
}

const TOKEN_PROBE_KEYS = [
  'schemaVersion',
  'inspectedPid',
  'sid',
  'isElevated',
  'elevationType',
  'hasAdministratorsSid',
  'integritySid',
  'profileHiveLoaded',
  'profileMatchesExpected',
] as const;

const TOKEN_PROBE_ENV_KEYS = [
  'SystemRoot',
  'WINDIR',
  'SystemDrive',
  'ComSpec',
  'Path',
  'PSModulePath',
  'USERPROFILE',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'TEMP',
  'TMP',
  'REVO_EXPECTED_PROFILE',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireExpectedSid(value: unknown): string {
  if (typeof value !== 'string' || !/^S-1-5-21-(?:\d+-){3}\d+$/u.test(value)) {
    throw new Error('WINDOWS_EXPECTED_SID_INVALID');
  }
  return value;
}

export function requireExpectedProfile(value: unknown): string {
  if (typeof value !== 'string' || !win32.isAbsolute(value)) {
    throw new Error('WINDOWS_EXPECTED_PROFILE_INVALID');
  }
  return value;
}

export function decodeTokenProbe(value: unknown): WindowsTokenProbe {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== TOKEN_PROBE_KEYS.length ||
    !TOKEN_PROBE_KEYS.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error('WINDOWS_TOKEN_PROBE_INVALID');
  }

  const {
    schemaVersion,
    inspectedPid,
    sid,
    isElevated,
    elevationType,
    hasAdministratorsSid,
    integritySid,
    profileHiveLoaded,
    profileMatchesExpected,
  } = value;
  if (
    schemaVersion !== 1 ||
    typeof inspectedPid !== 'number' ||
    !Number.isInteger(inspectedPid) ||
    inspectedPid < 1 ||
    inspectedPid > 2_147_483_647 ||
    typeof sid !== 'string' ||
    sid.length === 0 ||
    sid.length > 256 ||
    typeof isElevated !== 'boolean' ||
    typeof elevationType !== 'number' ||
    !Number.isInteger(elevationType) ||
    elevationType < 0 ||
    elevationType > 4_294_967_295 ||
    typeof hasAdministratorsSid !== 'boolean' ||
    typeof integritySid !== 'string' ||
    integritySid.length === 0 ||
    integritySid.length > 256 ||
    typeof profileHiveLoaded !== 'boolean' ||
    typeof profileMatchesExpected !== 'boolean'
  ) {
    throw new Error('WINDOWS_TOKEN_PROBE_INVALID');
  }

  return {
    schemaVersion,
    inspectedPid,
    sid,
    isElevated,
    elevationType,
    hasAdministratorsSid,
    integritySid,
    profileHiveLoaded,
    profileMatchesExpected,
  };
}

export function parseTokenProbe(text: string): WindowsTokenProbe {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('WINDOWS_TOKEN_PROBE_INVALID');
  }
  return decodeTokenProbe(value);
}

export function decodeTokenProbeCommandResult(
  result: Pick<SpawnSyncReturns<string>, 'error' | 'status' | 'signal' | 'stdout' | 'stderr'>,
): WindowsTokenProbe {
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    result.signal !== null ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string' ||
    result.stderr.length !== 0
  ) {
    throw new Error('WINDOWS_TOKEN_PROBE_FAILED');
  }

  try {
    return parseTokenProbe(result.stdout.trim());
  } catch {
    throw new Error('WINDOWS_TOKEN_PROBE_FAILED');
  }
}

export function runTokenProbeCommand(
  run: () => Pick<SpawnSyncReturns<string>, 'error' | 'status' | 'signal' | 'stdout' | 'stderr'>,
): WindowsTokenProbe {
  let result: Pick<SpawnSyncReturns<string>, 'error' | 'status' | 'signal' | 'stdout' | 'stderr'>;
  try {
    result = run();
  } catch {
    throw new Error('WINDOWS_TOKEN_PROBE_FAILED');
  }
  return decodeTokenProbeCommandResult(result);
}

export class WindowsProcessIdentityScenario {
  inspectCurrentProcessToken(): WindowsTokenProbe {
    const probe = process.env.REVO_TOKEN_PROBE_SCRIPT;
    const powershell = process.env.REVO_PWSH_EXE;
    const expectedProfile = process.env.REVO_EXPECTED_PROFILE;
    if (
      !probe ||
      !powershell ||
      !win32.isAbsolute(probe) ||
      !win32.isAbsolute(powershell) ||
      !expectedProfile ||
      !win32.isAbsolute(expectedProfile)
    ) {
      throw new Error('WINDOWS_TOKEN_PROBE_FAILED');
    }

    const env: NodeJS.ProcessEnv = {};
    for (const key of TOKEN_PROBE_ENV_KEYS) {
      const value = process.env[key];
      if (typeof value === 'string') {
        env[key] = value;
      }
    }

    return runTokenProbeCommand(() =>
      spawnSync(
        powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', probe, String(process.pid)],
        {
          cwd: win32.dirname(probe),
          env,
          encoding: 'utf8',
          maxBuffer: 8192,
          timeout: 15_000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
  }

  async capturesCurrentProcessThroughNest() {
    const context = await NestFactory.createApplicationContext(ProcessesModule, { logger: false });
    try {
      const service = context.get(ProcessIdentityService);
      const identity = await service.capture(process.pid);
      const inspection = await service.inspect(identity);
      return { identity, inspection };
    } finally {
      await context.close();
    }
  }
}
