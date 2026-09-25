// oxlint-disable curly -- compact validation guards keep the command boundary readable

import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import type { PackageArtifactPolicy, PackageArtifactRequest } from './package-artifacts.js';
import type { PackageInstallPlan } from './package-install-plan.js';
import {
  runPackageProcess,
  type PackageProcessPolicy,
  type PackageProcessResult,
} from './package-process.js';
import { acquireAndStagePackage, type PackageStage } from './package-stage.js';
import type { PnpmProgressSink } from './pnpm-progress.js';

export const PACKAGE_INSTALL_ARGS = Object.freeze([
  'install',
  '--prod',
  '--frozen-lockfile',
  '--reporter=ndjson',
  '--store-dir',
  'channel-local',
  '--pm-on-fail=error',
  '--config.strict-dep-builds=true',
  '--config.verify-store-integrity=true',
]);
const registry = 'https://registry.npmjs.org/';
const error = (reason: string): Error => new Error(`package install: ${reason}`);
const privatePnpmConfig = async () => {
  const root = await mkdtemp(join(tmpdir(), 'revo-pnpm-install-'));
  const paths = {
    home: join(root, 'home'),
    config: join(root, 'config'),
    cache: join(root, 'cache'),
    data: join(root, 'data'),
    state: join(root, 'state'),
    tmp: join(root, 'tmp'),
  };
  try {
    await Promise.all(Object.values(paths).map((path) => mkdir(path, { mode: 0o700 })));
    return { root, paths };
  } catch (cause) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw cause;
  }
};
const absoluteRegularFile = async (value: string, label: string): Promise<void> => {
  if (!value.startsWith('/')) throw error(`${label} must be absolute`);
  const info = await lstat(value).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.isSymbolicLink())
    throw error(`${label} must be a regular file`);
};
const environment = (
  nodeExecutable: string,
  pnpmExecutable: string,
  isolated: Awaited<ReturnType<typeof privatePnpmConfig>>['paths'],
): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !/^(?:HOME$|XDG_|npm_config_|NPM_CONFIG_|pnpm_|PNPM_|NODE_OPTIONS$)/u.test(key)
    )
      values[key] = value;
  }
  const dirs = [...new Set([dirname(nodeExecutable), dirname(pnpmExecutable)])];
  return {
    ...values,
    HOME: isolated.home,
    XDG_CONFIG_HOME: isolated.config,
    XDG_CACHE_HOME: isolated.cache,
    XDG_DATA_HOME: isolated.data,
    XDG_STATE_HOME: isolated.state,
    TMPDIR: isolated.tmp,
    PATH: [...dirs, '/usr/bin', '/bin'].join(delimiter),
    CI: '1',
    NO_COLOR: '1',
    npm_config_color: 'false',
    npm_config_registry: registry,
    npm_config_userconfig: join('/nonexistent', 'revo-npmrc'),
    npm_config_globalconfig: join('/nonexistent', 'revo-global-npmrc'),
  };
};

export interface PackageInstallResult {
  readonly directory: string;
  readonly packageDirectory: string;
  readonly version: string;
  readonly diagnosticPath: string;
  readonly process: PackageProcessResult;
}
export async function installPackage({
  stage,
  pnpmExecutable,
  nodeExecutable,
  signal,
  policy,
  diagnosticPath = join(stage.directory, '.package-install.log'),
  progress,
}: {
  readonly stage: PackageStage;
  readonly pnpmExecutable: string;
  readonly nodeExecutable: string;
  readonly signal?: AbortSignal;
  readonly policy?: PackageProcessPolicy;
  readonly diagnosticPath?: string;
  readonly progress?: PnpmProgressSink;
}): Promise<PackageInstallResult> {
  await absoluteRegularFile(pnpmExecutable, 'pnpm executable');
  await absoluteRegularFile(nodeExecutable, 'Node executable');
  if (!stage.directory.startsWith('/') || !stage.packageDirectory.startsWith('/'))
    throw error('stage paths must be absolute');
  const info = await lstat(stage.packageDirectory).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink())
    throw error('package stage is unavailable');
  await mkdir(join(stage.packageDirectory, 'channel-local'), { recursive: true, mode: 0o700 });
  const isolated = await privatePnpmConfig();
  try {
    const result = await runPackageProcess({
      executable: pnpmExecutable,
      args: PACKAGE_INSTALL_ARGS,
      cwd: stage.packageDirectory,
      env: environment(nodeExecutable, pnpmExecutable, isolated.paths),
      diagnosticPath,
      ...(progress === undefined ? {} : { progress }),
      ...(signal === undefined ? {} : { signal }),
      ...(policy === undefined ? {} : { policy }),
    });
    if (result.exitCode !== 0 || result.signal !== null)
      throw Object.assign(error(`pnpm exited with ${result.exitCode ?? result.signal}`), {
        result,
      });
    return {
      directory: stage.directory,
      packageDirectory: stage.packageDirectory,
      version: stage.version,
      diagnosticPath,
      process: result,
    };
  } finally {
    await rm(isolated.root, { recursive: true, force: true }).catch(() => {});
  }
}

export async function acquireAndInstallPackage({
  plan,
  scratch,
  pnpmExecutable,
  nodeExecutable,
  artifactPolicy,
  processPolicy,
  signal,
  request,
  onProgress,
  progress,
}: {
  readonly plan: PackageInstallPlan;
  readonly scratch: string;
  readonly pnpmExecutable: string;
  readonly nodeExecutable: string;
  readonly artifactPolicy?: PackageArtifactPolicy;
  readonly processPolicy?: PackageProcessPolicy;
  readonly signal?: AbortSignal;
  readonly request?: PackageArtifactRequest;
  readonly onProgress?: (stage: string, artifact?: string) => void;
  readonly progress?: PnpmProgressSink;
}): Promise<PackageInstallResult> {
  const stage = await acquireAndStagePackage({
    plan,
    scratch,
    ...(artifactPolicy === undefined ? {} : { policy: artifactPolicy }),
    ...(signal === undefined ? {} : { signal }),
    ...(request === undefined ? {} : { request }),
    ...(onProgress === undefined ? {} : { onProgress }),
  });
  onProgress?.('dependencies');
  return await installPackage({
    stage,
    pnpmExecutable,
    nodeExecutable,
    ...(processPolicy === undefined ? {} : { policy: processPolicy }),
    ...(signal === undefined ? {} : { signal }),
    ...(progress === undefined ? {} : { progress }),
  });
}

export const installPackageDependencies = installPackage;
