import { execFile as execFileCallback } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { acquireAndStagePackage } from '../../src/installation/package-stage.js';
import type { packageArtifactScenario } from '../support/installation/package-artifact-scenario.js';
import { superviseInstallDiagnostic } from '../support/installation/pnpm-install-diagnostic-supervisor.mjs';
import {
  downloadPinnedPnpmArchive,
  extractVerifiedPnpmArchive,
} from '../support/installation/pnpm-install-diagnostic-support.mjs';

const enabled = process.env.REVO_RUN_PNPM_INSTALL_DIAGNOSTIC === '1';
const execFile = promisify(execFileCallback);
const driverPath = fileURLToPath(
  new URL('../support/installation/pnpm-install-diagnostic-child.mjs', import.meta.url),
);
const installModuleUrl = new URL('../../dist/installation/package-install.js', import.meta.url)
  .href;

function privateEnvironment(
  root: string,
  nodePath: string,
  pnpmPath: string,
): Record<string, string> {
  const home = join(root, 'home');
  const xdg = join(root, 'xdg');
  const environment: Record<string, string> = {
    PATH: `${dirname(nodePath)}:${dirname(pnpmPath)}:/usr/bin:/bin`,
    HOME: home,
    XDG_CACHE_HOME: join(xdg, 'cache'),
    XDG_CONFIG_HOME: join(xdg, 'config'),
    XDG_DATA_HOME: join(xdg, 'data'),
    XDG_STATE_HOME: join(xdg, 'state'),
    XDG_RUNTIME_DIR: join(xdg, 'runtime'),
    PNPM_HOME: join(root, 'pnpm-home'),
    TMPDIR: join(root, 'tmp'),
    CI: '1',
    NO_COLOR: '1',
    LANG: 'C.UTF-8',
  };
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'] as const) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

describe('manual real pnpm install timing diagnostic', () => {
  it(
    'records one bounded, cancellable install attempt using the compiled package installer',
    async () => {
      if (!enabled) {
        return;
      }
      if (process.platform !== 'linux' || process.arch !== 'x64') {
        throw new Error('manual pnpm diagnostic requires the isolated Linux x64 sandbox');
      }
      if (process.versions.node !== '26.8.2') {
        throw new Error('manual pnpm diagnostic requires Node 26.8.2');
      }

      const root = await mkdtemp('/tmp/revo-pnpm-install-diagnostic-');
      let scenario: Awaited<ReturnType<typeof packageArtifactScenario>> | undefined;
      let cleanupConfirmed = false;
      let driverStarted = false;
      let phase = 'private-workspace';
      try {
        for (const directory of [
          'toolchain',
          'home',
          'xdg/cache',
          'xdg/config',
          'xdg/data',
          'xdg/state',
          'xdg/runtime',
          'pnpm-home',
          'tmp',
        ]) {
          // oxlint-disable-next-line no-await-in-loop -- finish all private directories before setup and cleanup proceed.
          await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
        }

        phase = 'fixture-stage';
        const [{ packageArtifactScenario: createScenario }, { pnpmReleaseManifestFixture }] =
          await Promise.all([
            import('../support/installation/package-artifact-scenario.js'),
            import('../support/installation/release-manifest-fixture.js'),
          ]);
        scenario = await createScenario({ realActivation: true });
        const stage = await acquireAndStagePackage({
          plan: scenario.plan,
          scratch: scenario.scratch,
          request: scenario.request,
        });

        phase = 'private-node-probe';
        const privateNode = join(root, 'toolchain', 'node');
        await copyFile(process.execPath, privateNode);
        await chmod(privateNode, 0o700);
        const initialEnvironment = privateEnvironment(root, privateNode, privateNode);
        const nodeVersion = await execFile(privateNode, ['--version'], {
          cwd: root,
          env: initialEnvironment,
          timeout: 10_000,
          maxBuffer: 1_024,
        });
        if (nodeVersion.stdout.trim() !== 'v26.8.2') {
          throw new Error('private Node version mismatch');
        }

        phase = 'pnpm-archive-download';
        const release = pnpmReleaseManifestFixture();
        const archive = release.manifest.toolchain.pnpmArchives.find(
          (item) => item.platform === 'linux' && item.arch === 'x64',
        );
        if (
          !archive ||
          archive.format !== 'tar.gz' ||
          release.manifest.toolchain.pnpm !== '12.5.1'
        ) {
          throw new Error('pinned pnpm archive fixture is unavailable');
        }
        const archivePath = join(root, 'toolchain', 'pnpm.tar.gz');
        const downloaded = await downloadPinnedPnpmArchive({
          descriptor: archive,
          destination: archivePath,
        });
        if (downloaded.size > 64 * 1024 * 1024 || downloaded.sha256 !== archive.sha256) {
          throw new Error('pnpm archive verification failed');
        }

        phase = 'pnpm-archive-extract';
        const pnpm = await extractVerifiedPnpmArchive({
          archivePath,
          destinationRoot: join(root, 'toolchain'),
          expectedSha256: archive.sha256,
        });
        const environment = privateEnvironment(root, privateNode, pnpm.executablePath);

        phase = 'private-pnpm-probe';
        const pnpmVersion = await execFile(pnpm.executablePath, ['--version'], {
          cwd: root,
          env: environment,
          timeout: 30_000,
          maxBuffer: 1_024,
        });
        if (pnpmVersion.stdout.trim() !== '12.5.1') {
          throw new Error('private pnpm version mismatch');
        }

        phase = 'install-driver';
        driverStarted = true;
        const report = await superviseInstallDiagnostic({
          driverPath,
          input: {
            moduleUrl: installModuleUrl,
            nodeExecutable: privateNode,
            pnpmExecutable: pnpm.executablePath,
            stage: {
              directory: stage.directory,
              packageDirectory: stage.packageDirectory,
              version: stage.version,
            },
          },
          environment,
        });
        cleanupConfirmed = report.cleanupConfirmed;
        console.info(`PNPM_DIAGNOSTIC_REPORT ${JSON.stringify(report)}`);
        expect(report.pnpmSpawnSeen).toBe(true);
        expect(report.pnpmCloseSeen).toBe(true);
        expect(report.cleanupConfirmed).toBe(true);
        expect(report.outcome).toBe('success');
      } catch {
        if (!driverStarted) {
          console.info(`PNPM_DIAGNOSTIC_PREPARATION_FAILURE ${JSON.stringify({ phase })}`);
          throw new Error(`manual pnpm diagnostic preparation failed at ${phase}`);
        }
        throw new Error('manual pnpm diagnostic did not complete successfully');
      } finally {
        if (!driverStarted || cleanupConfirmed) {
          await scenario?.cleanup().catch(() => undefined);
          await rm(root, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    },
    20 * 60_000,
  );
});
