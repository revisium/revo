import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  symlink,
  unlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';

const TOOLING_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const PNPM_VERSION = '12.5.1';
const YAML_VERSION = '2.9.1';

function fail(message) {
  throw new Error(`acceptance tooling: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashInputs(root) {
  const entries = await Promise.all(
    TOOLING_FILES.map(async (name) => {
      const bytes = await readFile(join(root, name));
      return /** @type {const} */ ([name, sha256(bytes)]);
    }),
  );
  return new Map(entries);
}

async function assertInputsUnchanged(root, expected) {
  const actual = await hashInputs(root);
  for (const name of TOOLING_FILES) {
    if (actual.get(name) !== expected.get(name)) {
      fail(`tooling input changed during install: ${name}`);
    }
  }
}

function runPnpm(args, options) {
  const result = spawnSync(options.pnpmPath, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(`pnpm ${args[0]} failed${result.error ? `: ${result.error.message}` : ''}`);
  }
  return result.stdout.trim();
}

async function ensureLinkAbsent(path) {
  try {
    await lstat(path);
    fail(`module-link destination already exists: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

export async function bootstrapAcceptanceTooling({
  repositoryRoot,
  runnerTemp,
  pnpmPath = 'pnpm',
}) {
  const repo = await realpath(repositoryRoot);
  const tempParent = await realpath(runnerTemp);
  const nodeVersion = (await readFile(join(repo, '.nvmrc'), 'utf8')).trim();
  if (process.version !== `v${nodeVersion}`) {
    fail(`Node.js ${nodeVersion} is required; found ${process.version}`);
  }

  const rootPackage = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  const sourceRoot = join(repo, 'scripts', 'acceptance', 'tooling');
  const toolingPackage = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  const rootYamlVersion = rootPackage.dependencies?.yaml ?? rootPackage.devDependencies?.yaml;
  if (
    rootPackage.packageManager !== `pnpm@${PNPM_VERSION}` ||
    toolingPackage.packageManager !== `pnpm@${PNPM_VERSION}` ||
    toolingPackage.dependencies?.yaml !== YAML_VERSION ||
    rootYamlVersion !== YAML_VERSION
  ) {
    fail('root and isolated tooling pins do not match the acceptance profile');
  }
  const actualPnpmVersion = runPnpm(['--version'], { cwd: repo, env: process.env, pnpmPath });
  if (actualPnpmVersion !== PNPM_VERSION) {
    fail(`pnpm ${PNPM_VERSION} is required; found ${actualPnpmVersion}`);
  }

  const toolingRoot = await mkdtemp(join(tempParent, 'revo-acceptance-tooling-'));
  await chmod(toolingRoot, 0o700);
  const copiedFiles = await Promise.all(
    TOOLING_FILES.map(async (name) => {
      const target = join(toolingRoot, name);
      await copyFile(join(sourceRoot, name), target, constants.COPYFILE_EXCL);
      await chmod(target, 0o600);
      return target;
    }),
  );
  const inputHashes = await hashInputs(toolingRoot);
  const home = join(toolingRoot, 'home');
  const cache = join(toolingRoot, 'cache');
  const store = join(toolingRoot, 'store');
  await Promise.all([home, cache, store].map((path) => mkdir(path, { mode: 0o700 })));
  const env = {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: cache,
    npm_config_cache: join(cache, 'npm'),
  };
  runPnpm(
    [
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--store-dir',
      store,
      '--pm-on-fail=error',
      '--config.verify-store-integrity=true',
    ],
    { cwd: toolingRoot, env, pnpmPath },
  );
  await assertInputsUnchanged(toolingRoot, inputHashes);

  const acceptanceDir = join(repo, 'scripts', 'acceptance');
  const moduleLink = join(acceptanceDir, 'node_modules');
  await ensureLinkAbsent(moduleLink);
  await symlink(join(toolingRoot, 'node_modules'), moduleLink, 'dir');

  try {
    const resolvedYaml = await realpath(
      createRequire(join(acceptanceDir, 'preparation-receipt.mjs')).resolve('yaml'),
    );
    const resolvedToolingRoot = await realpath(toolingRoot);
    const relativeYaml = relative(resolvedToolingRoot, resolvedYaml);
    if (
      relativeYaml.startsWith(`..${sep}`) ||
      relativeYaml === '..' ||
      relativeYaml.startsWith(sep)
    ) {
      fail('YAML resolved outside the isolated tooling project');
    }
    const installedYaml = JSON.parse(
      await readFile(join(toolingRoot, 'node_modules', 'yaml', 'package.json'), 'utf8'),
    );
    if (installedYaml.version !== YAML_VERSION) {
      fail(`isolated YAML ${YAML_VERSION} is required; found ${installedYaml.version}`);
    }
    return { toolingRoot, moduleLink, copiedFiles };
  } catch (error) {
    const linkTarget = await readlink(moduleLink).catch(() => null);
    if (linkTarget === join(toolingRoot, 'node_modules')) {
      await unlink(moduleLink);
    }
    throw error;
  }
}

async function main(argv) {
  if (argv.length !== 2 || !argv[0] || !argv[1]) {
    fail('usage: bootstrap-tooling.mjs REPOSITORY_ROOT RUNNER_TEMP');
  }
  const result = await bootstrapAcceptanceTooling({ repositoryRoot: argv[0], runnerTemp: argv[1] });
  process.stdout.write(`${result.toolingRoot}\n`);
}

if (process.argv[1]?.endsWith('/bootstrap-tooling.mjs')) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  });
}
