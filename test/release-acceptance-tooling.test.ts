import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bootstrapAcceptanceTooling } from '../scripts/acceptance/bootstrap-tooling.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release acceptance tooling bootstrap', () => {
  it('installs only the pinned tooling project and resolves YAML through the acceptance module', async () => {
    const subject = await createFixture();
    const result = await bootstrapAcceptanceTooling({
      repositoryRoot: subject.repositoryRoot,
      runnerTemp: subject.runnerTemp,
      pnpmPath: subject.pnpmPath,
    });
    const invocation: unknown = JSON.parse(
      await readFile(join(result.toolingRoot, 'install-args.json'), 'utf8'),
    );

    expect(invocation).toMatchObject({
      cwd: result.toolingRoot,
      args: expect.arrayContaining([
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--config.verify-store-integrity=true',
      ]),
    });
    expect(await readFile(join(result.toolingRoot, 'package.json'), 'utf8')).toContain(
      'revo-acceptance-tooling',
    );
    await expect(readFile(join(subject.repositoryRoot, 'node_modules'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(result.moduleLink, 'yaml', 'package.json'), 'utf8')).toContain(
      '2.9.1',
    );
  });

  it('fails without replacing an existing module-link destination', async () => {
    const subject = await createFixture();
    const moduleLink = join(subject.repositoryRoot, 'scripts', 'acceptance', 'node_modules');
    await writeFile(moduleLink, 'preserve this destination');

    await expect(
      bootstrapAcceptanceTooling({
        repositoryRoot: subject.repositoryRoot,
        runnerTemp: subject.runnerTemp,
        pnpmPath: subject.pnpmPath,
      }),
    ).rejects.toThrow(/destination already exists/u);
    expect(await readFile(moduleLink, 'utf8')).toBe('preserve this destination');
  });

  it('rejects mismatched root and tooling pins before running pnpm', async () => {
    const subject = await createFixture({ rootYamlVersion: '2.9.0' });

    await expect(
      bootstrapAcceptanceTooling({
        repositoryRoot: subject.repositoryRoot,
        runnerTemp: subject.runnerTemp,
        pnpmPath: subject.pnpmPath,
      }),
    ).rejects.toThrow(/pins do not match/u);
    await expect(readFile(subject.pnpmLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an installed YAML version that differs from the pinned version', async () => {
    const subject = await createFixture({ installedYamlVersion: '2.9.0' });

    await expect(
      bootstrapAcceptanceTooling({
        repositoryRoot: subject.repositoryRoot,
        runnerTemp: subject.runnerTemp,
        pnpmPath: subject.pnpmPath,
      }),
    ).rejects.toThrow(/isolated YAML 2\.9\.1 is required/u);
    await expect(
      readFile(join(subject.repositoryRoot, 'scripts', 'acceptance', 'node_modules')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects pnpm failure and tooling input changes before creating the module link', async () => {
    const installFailure = await createFixture({ pnpmFailure: true });
    await expect(
      bootstrapAcceptanceTooling({
        repositoryRoot: installFailure.repositoryRoot,
        runnerTemp: installFailure.runnerTemp,
        pnpmPath: installFailure.pnpmPath,
      }),
    ).rejects.toThrow(/pnpm install failed/u);

    const changedInput = await createFixture({ mutateWorkspaceDuringInstall: true });
    await expect(
      bootstrapAcceptanceTooling({
        repositoryRoot: changedInput.repositoryRoot,
        runnerTemp: changedInput.runnerTemp,
        pnpmPath: changedInput.pnpmPath,
      }),
    ).rejects.toThrow(/tooling input changed during install/u);
    await expect(
      readFile(join(changedInput.repositoryRoot, 'scripts', 'acceptance', 'node_modules')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('release acceptance tooling workflow order', () => {
  it('bootstraps isolated YAML before artifact verification and product frozen install', async () => {
    const workflow = await readFile(
      join(process.cwd(), '.github', 'workflows', 'release-acceptance.yml'),
      'utf8',
    );
    const bootstrap = workflow.indexOf('bootstrap-tooling.mjs');
    const artifactVerification = workflow.indexOf('name: Verify exact TUI package');
    const preparation = workflow.indexOf('name: Prepare isolated Revo staging copy');
    const receiptGate = workflow.indexOf('preparation-receipt.mjs staging');
    const frozenInstall = workflow.indexOf('pnpm --dir "$stage" install --frozen-lockfile');

    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(bootstrap).toBeLessThan(artifactVerification);
    expect(artifactVerification).toBeLessThan(preparation);
    expect(preparation).toBeLessThan(receiptGate);
    expect(receiptGate).toBeLessThan(frozenInstall);
    expect(workflow).not.toContain('pnpm install --frozen-lockfile --ignore-scripts');
  });

  it('stops before install, build, and bundle when the real workflow receipt gate fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-acceptance-workflow-gate-'));
    roots.push(root);
    const runnerTemp = join(root, 'runner-temp');
    const tools = join(root, 'tools');
    const stage = join(runnerTemp, 'revo-staging');
    const tui = join(runnerTemp, 'tui-artifact');
    await mkdir(runnerTemp);
    await Promise.all([mkdir(tools), mkdir(stage), mkdir(tui)]);
    const packageFilename = 'tui-fixture.tgz';
    await writeFile(
      join(tui, 'release-package-manifest.json'),
      JSON.stringify({ package: { filename: packageFilename, version: '0.0.0' } }),
    );
    await writeFile(join(tui, packageFilename), 'TUI fixture');
    const pnpmMarker = join(root, 'pnpm-was-called');
    const fakePnpm = join(tools, 'pnpm');
    await writeFile(fakePnpm, `#!/bin/sh\nprintf called > "${pnpmMarker}"\nexit 0\n`);
    await chmod(fakePnpm, 0o700);
    const workflow = await readFile(
      join(process.cwd(), '.github', 'workflows', 'release-acceptance.yml'),
      'utf8',
    );
    const script = workflowRunBlock(workflow, 'Install and build the isolated bundle');
    const result = spawnSync('bash', ['-lc', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        ACCEPTANCE_CHANNEL: 'stable',
        PATH: `${tools}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: runnerTemp,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/acceptance receipt/u);
    await expect(readFile(pnpmMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(runnerTemp, 'revo-bundle'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

async function createFixture(
  options: {
    rootYamlVersion?: string;
    installedYamlVersion?: string;
    pnpmVersion?: string;
    pnpmFailure?: boolean;
    mutateWorkspaceDuringInstall?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'revo-acceptance-tooling-test-'));
  roots.push(root);
  const repositoryRoot = join(root, 'repo');
  const runnerTemp = join(root, 'runner-temp');
  const tooling = join(repositoryRoot, 'scripts', 'acceptance', 'tooling');
  const acceptance = join(repositoryRoot, 'scripts', 'acceptance');
  const bin = join(root, 'bin');
  await Promise.all([mkdir(tooling, { recursive: true }), mkdir(runnerTemp), mkdir(bin)]);
  await writeFile(join(repositoryRoot, '.nvmrc'), `${process.version.slice(1)}\n`);
  await writeFile(
    join(repositoryRoot, 'package.json'),
    JSON.stringify({
      packageManager: 'pnpm@12.5.1',
      devDependencies: { yaml: options.rootYamlVersion ?? '2.9.1' },
    }),
  );
  await writeFile(
    join(tooling, 'package.json'),
    JSON.stringify({
      name: 'revo-acceptance-tooling',
      version: '0.0.0',
      private: true,
      packageManager: 'pnpm@12.5.1',
      dependencies: { yaml: '2.9.1' },
    }),
  );
  await writeFile(join(tooling, 'pnpm-lock.yaml'), 'generated lock fixture\n');
  await writeFile(join(tooling, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFile(join(acceptance, 'preparation-receipt.mjs'), '');

  const pnpmPath = join(bin, 'pnpm');
  const pnpmLog = join(root, 'pnpm-called.json');
  await writeFile(
    pnpmPath,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write(${JSON.stringify(`${options.pnpmVersion ?? '12.5.1'}\n`)});
  process.exit(0);
}
${options.pnpmFailure ? 'process.exit(9);' : ''}
writeFileSync(${JSON.stringify(pnpmLog)}, JSON.stringify({ cwd: process.cwd(), args }));
const packageRoot = join(process.cwd(), 'node_modules', 'yaml');
mkdirSync(packageRoot, { recursive: true });
writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'yaml', version: ${JSON.stringify(options.installedYamlVersion ?? '2.9.1')}, main: 'index.cjs' }));
writeFileSync(join(packageRoot, 'index.cjs'), 'module.exports = {};\\n');
writeFileSync(join(process.cwd(), 'install-args.json'), JSON.stringify({ cwd: process.cwd(), args }));
${options.mutateWorkspaceDuringInstall ? "writeFileSync(join(process.cwd(), 'pnpm-workspace.yaml'), 'mutated\\n');" : ''}
`,
  );
  await chmod(pnpmPath, 0o700);
  return { repositoryRoot, runnerTemp, pnpmPath, pnpmLog };
}

function workflowRunBlock(workflow: string, stepName: string): string {
  const lines = workflow.split('\n');
  const stepStart = lines.findIndex((line) => line === `      - name: ${stepName}`);
  if (stepStart < 0) {
    throw new Error(`workflow step is missing: ${stepName}`);
  }
  const nextStep = lines.findIndex(
    (line, index) => index > stepStart && /^      - name:/.test(line),
  );
  const stepLines = lines.slice(stepStart, nextStep < 0 ? undefined : nextStep);
  const runStart = stepLines.findIndex((line) => line === '        run: |');
  if (runStart < 0) {
    throw new Error(`workflow run block is missing: ${stepName}`);
  }
  const scriptLines: string[] = [];
  for (const line of stepLines.slice(runStart + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) {
      break;
    }
    scriptLines.push(line.startsWith('          ') ? line.slice(10) : '');
  }
  return scriptLines.join('\n');
}
