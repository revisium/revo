import { readFile, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  acquireAndInstallPackage,
  installPackage,
  PACKAGE_INSTALL_ARGS,
} from '../../src/installation/package-install.js';
import { runPackageProcess } from '../../src/installation/package-process.js';
import { acquireAndStagePackage } from '../../src/installation/package-stage.js';
import { packageInstallScenario } from '../support/installation/package-install-scenario.js';

describe('managed package installation', () => {
  it('uses the exact frozen production command and a hermetic environment', async () => {
    const data = await packageInstallScenario();
    const stage = await acquireAndStagePackage({
      plan: data.plan,
      scratch: data.scratch,
      request: data.request,
    });
    process.env.PNPM_CONFIG_USER_AGENT = 'ambient-sentinel';
    const result = await installPackage({
      stage,
      pnpmExecutable: data.pnpm,
      nodeExecutable: data.node,
      diagnosticPath: `${data.root}/install.log`,
    });
    const capture = await data.readCapture();
    expect(capture.argv).toEqual(PACKAGE_INSTALL_ARGS);
    expect(capture.env.PATH).toContain(dirname(data.node));
    expect(capture.env.PNPM_CONFIG_USER_AGENT).toBeUndefined();
    expect(capture.env.npm_config_registry).toBe('https://registry.npmjs.org/');
    expect(result.process.exitCode).toBe(0);
    expect(await data.mode(result.diagnosticPath)).toBe(0o600);
    await data.cleanup();
    delete process.env.PNPM_CONFIG_USER_AGENT;
  });

  it('records bounded diagnostics and rejects a failed install without leaking output', async () => {
    const data = await packageInstallScenario();
    const stage = await acquireAndStagePackage({
      plan: data.plan,
      scratch: data.scratch,
      request: data.request,
    });
    process.env.REVO_EXIT = '7';
    await expect(
      installPackage({
        stage,
        pnpmExecutable: data.pnpm,
        nodeExecutable: data.node,
        diagnosticPath: `${data.root}/failed.log`,
      }),
    ).rejects.toMatchObject({ result: { exitCode: 7 } });
    await expect(readFile(`${data.root}/failed.log`, 'utf8')).resolves.toContain('stdout:');
    await data.cleanup();
    delete process.env.REVO_EXIT;
  });

  it('preserves child signal status and drains on cancellation', async () => {
    const data = await packageInstallScenario();
    const stage = await acquireAndStagePackage({
      plan: data.plan,
      scratch: data.scratch,
      request: data.request,
    });
    process.env.REVO_SIGNAL = 'SIGINT';
    await expect(
      installPackage({
        stage,
        pnpmExecutable: data.pnpm,
        nodeExecutable: data.node,
        diagnosticPath: `${data.root}/signal.log`,
      }),
    ).rejects.toMatchObject({ result: { signal: 'SIGINT' } });
    delete process.env.REVO_SIGNAL;
    const controller = new AbortController();
    process.env.REVO_HANG = '1';
    const promise = installPackage({
      stage,
      pnpmExecutable: data.pnpm,
      nodeExecutable: data.node,
      signal: controller.signal,
      diagnosticPath: `${data.root}/cancel.log`,
      policy: { terminationGraceMs: 100, killWaitMs: 1_000 },
    });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow(/cancel/iu);
    delete process.env.REVO_HANG;
    await data.cleanup();
  });

  it('acquires, stages, and installs into an isolated package directory', async () => {
    const data = await packageInstallScenario();
    const result = await acquireAndInstallPackage({
      plan: data.plan,
      scratch: data.scratch,
      pnpmExecutable: data.pnpm,
      nodeExecutable: data.node,
      request: data.request,
    });
    expect(result.packageDirectory).toContain('.package-stage-');
    expect(await readdir(result.packageDirectory)).toEqual(
      expect.arrayContaining(['package.json', 'channel-local']),
    );
    await data.cleanup();
  });

  it('rejects pre-cancelled and reused diagnostic paths', async () => {
    const data = await packageInstallScenario();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      runPackageProcess({
        executable: data.pnpm,
        args: [],
        cwd: data.root,
        env: {},
        diagnosticPath: `${data.root}/early.log`,
        signal: cancelled.signal,
      }),
    ).rejects.toThrow(/cancel/iu);
    const diagnosticPath = `${data.root}/exclusive.log`;
    await runPackageProcess({
      executable: data.pnpm,
      args: [],
      cwd: data.root,
      env: { PATH: dirname(data.node), REVO_CAPTURE: data.capture },
      diagnosticPath,
    });
    await expect(
      runPackageProcess({
        executable: data.pnpm,
        args: [],
        cwd: data.root,
        env: {},
        diagnosticPath,
      }),
    ).rejects.toThrow(/exclusively/iu);
    await data.cleanup();
  });

  it('bounds output, enforces deadlines, and reports spawn failures', async () => {
    const data = await packageInstallScenario();
    process.env.REVO_BURST = '1';
    await expect(
      runPackageProcess({
        executable: data.pnpm,
        args: [],
        cwd: data.root,
        env: { PATH: dirname(data.node), REVO_BURST: '1', REVO_CAPTURE: data.capture },
        diagnosticPath: `${data.root}/burst.log`,
        policy: { maxDiagnosticBytes: 100, terminationGraceMs: 100, killWaitMs: 1_000 },
      }),
    ).rejects.toThrow(/exceeded/iu);
    delete process.env.REVO_BURST;
    process.env.REVO_HANG = '1';
    await expect(
      runPackageProcess({
        executable: data.pnpm,
        args: [],
        cwd: data.root,
        env: { PATH: dirname(data.node), REVO_HANG: '1', REVO_CAPTURE: data.capture },
        diagnosticPath: `${data.root}/timeout.log`,
        policy: { timeoutMs: 50, terminationGraceMs: 100, killWaitMs: 1_000 },
      }),
    ).rejects.toThrow(/timed out/iu);
    delete process.env.REVO_HANG;
    await expect(
      runPackageProcess({
        executable: `${data.root}/missing-pnpm`,
        args: [],
        cwd: data.root,
        env: {},
        diagnosticPath: `${data.root}/spawn.log`,
      }),
    ).rejects.toThrow(/spawn|ENOENT/iu);
    await data.cleanup();
  });

  it('validates process inputs and terminates resistant children on Windows semantics', async () => {
    const data = await packageInstallScenario();
    await expect(
      runPackageProcess({
        executable: 'pnpm',
        args: [],
        cwd: data.root,
        env: {},
        diagnosticPath: `${data.root}/relative.log`,
      }),
    ).rejects.toThrow(/absolute/iu);
    await expect(
      runPackageProcess({
        executable: data.pnpm,
        args: [],
        cwd: data.root,
        env: {},
        diagnosticPath: `${data.root}/policy.log`,
        policy: { timeoutMs: -1 },
      }),
    ).rejects.toThrow(/policy/iu);
    await expect(
      runPackageProcess({
        executable: data.pnpm,
        args: [],
        cwd: data.root,
        env: {},
        diagnosticPath: `${data.root}/zero-policy.log`,
        policy: { timeoutMs: 0 },
      }),
    ).rejects.toThrow(/policy/iu);
    const stage = await acquireAndStagePackage({
      plan: data.plan,
      scratch: data.scratch,
      request: data.request,
    });
    await expect(
      installPackage({
        stage: { ...stage, directory: 'relative' },
        pnpmExecutable: data.pnpm,
        nodeExecutable: data.node,
      }),
    ).rejects.toThrow(/absolute/iu);
    await expect(
      installPackage({
        stage: { ...stage, packageDirectory: `${data.root}/missing` },
        pnpmExecutable: data.pnpm,
        nodeExecutable: data.node,
      }),
    ).rejects.toThrow(/unavailable/iu);
    const controller = new AbortController();
    const promise = runPackageProcess({
      executable: data.pnpm,
      args: [],
      cwd: data.root,
      env: {
        PATH: dirname(data.node),
        REVO_CAPTURE: data.capture,
        REVO_HANG: '1',
        REVO_RESIST: '1',
      },
      diagnosticPath: `${data.root}/windows.log`,
      signal: controller.signal,
      platform: 'win32',
      policy: { terminationGraceMs: 10, killWaitMs: 1_000 },
    });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow(/cancel/iu);
    await data.cleanup();
  });
});
