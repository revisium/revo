import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const workflowPath = join(process.cwd(), '.github', 'workflows', 'release-acceptance.yml');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release acceptance consumer workflow', () => {
  it.each([
    ['stable', '0.0.0'],
    ['alpha', '0.0.1-alpha.1'],
  ])(
    'uses the configured origin for the %s channel when start reports already running',
    async (channel, version) => {
      const subject = await createFixture({}, version);
      subject.extraEnvironment = await effectiveStepEnvironment(
        'lifecycle',
        channel,
        subject.runnerTemp,
      );
      const result = await runBash(subject, await lifecycleStep(channel));
      const requested = (await readFile(subject.curlUrls, 'utf8')).trim().split('\n');

      expect(result.code).toBe(0);
      expect(requested).toContain('http://127.0.0.1:33211/');
      expect(requested).toContain('http://127.0.0.1:33211/graphql');
      expect(requested).not.toContain('https://attacker.invalid/');
      expect(await readFile(subject.githubEnv, 'utf8')).toBe(
        'REVO_ACCEPTANCE_API_URL=http://127.0.0.1:33211/graphql\n',
      );
      const starts = (await readFile(subject.launcherCalls, 'utf8'))
        .trim()
        .split('\n')
        .filter((call) => call.endsWith('|server start'));
      expect(starts).toHaveLength(2);
    },
  );

  it('does not export an API URL when server start fails', async () => {
    const subject = await createFixture({ SERVER_START_FAIL: '1' });
    subject.extraEnvironment = {
      ...(await effectiveStepEnvironment('lifecycle', 'stable', subject.runnerTemp)),
      SERVER_START_FAIL: '1',
    };
    const result = await runBash(subject, await lifecycleStep('stable'));

    expect(result.code).not.toBe(0);
    await expect(readFile(subject.githubEnv, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not export an API URL when the configured GraphQL endpoint is unhealthy', async () => {
    const subject = await createFixture({ CURL_GRAPHQL_ERRORS: '1' });
    subject.extraEnvironment = {
      ...(await effectiveStepEnvironment('lifecycle', 'stable', subject.runnerTemp)),
      CURL_GRAPHQL_ERRORS: '1',
    };
    const result = await runBash(subject, await lifecycleStep('stable'));

    expect(result.code).not.toBe(0);
    await expect(readFile(subject.githubEnv, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['the restarted server start', { SERVER_START_FAIL_AT: '2' }],
    ['the Admin endpoint', { ADMIN_HTTP_ERRORS: '1' }],
    ['the post-restart GraphQL endpoint', { CURL_GRAPHQL_FAIL_AT: '2' }],
  ])('does not export an API URL when %s fails', async (_failure, failureEnvironment) => {
    const subject = await createFixture();
    subject.extraEnvironment = {
      ...(await effectiveStepEnvironment('lifecycle', 'stable', subject.runnerTemp)),
      ...failureEnvironment,
    };
    const result = await runBash(subject, await lifecycleStep('stable'));

    expect(result.code).not.toBe(0);
    await expect(readFile(subject.githubEnv, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['stable', 'alpha'])(
    'gives lifecycle, TUI, and cleanup the same effective paths for %s',
    async (channel) => {
      const fixtureRoot = await createFixture();
      const workflow = await readFile(workflowPath, 'utf8');
      const environments = await Promise.all(
        ['lifecycle', 'tui_acceptance', 'runtime_cleanup'].map((stepId) =>
          effectiveStepEnvironment(stepId, channel, fixtureRoot.runnerTemp, workflow),
        ),
      );
      const expected = {
        REVO_CHANNEL: channel,
        REVO_HOST: '127.0.0.1',
        REVO_PORT: '33211',
        REVO_INSTALL_ROOT: join(fixtureRoot.runnerTemp, 'revo-install'),
        REVO_DATA_DIR: join(fixtureRoot.runnerTemp, 'revo-data'),
        HOME: join(fixtureRoot.runnerTemp, 'revo-home'),
      };

      expect(() => assertConsistentStepEnvironments(environments, expected)).not.toThrow();
      expect(workflow).not.toMatch(
        /^      (?:REVO_INSTALL_ROOT|REVO_DATA_DIR|HOME): \$\{\{ runner\.temp \}\}/m,
      );
    },
  );

  it('detects a step-level data-root override instead of silently inheriting the expected root', async () => {
    const subject = await createFixture();
    const workflow = await readFile(workflowPath, 'utf8');
    const mutatedWorkflow = overrideStepEnvironment(
      workflow,
      'tui_acceptance',
      'REVO_DATA_DIR',
      '${{ runner.temp }}/wrong-data',
    );
    const expected = {
      REVO_CHANNEL: 'stable',
      REVO_HOST: '127.0.0.1',
      REVO_PORT: '33211',
      REVO_INSTALL_ROOT: join(subject.runnerTemp, 'revo-install'),
      REVO_DATA_DIR: join(subject.runnerTemp, 'revo-data'),
      HOME: join(subject.runnerTemp, 'revo-home'),
    };
    const environments = await Promise.all([
      effectiveStepEnvironment('lifecycle', 'stable', subject.runnerTemp, workflow),
      effectiveStepEnvironment('tui_acceptance', 'stable', subject.runnerTemp, mutatedWorkflow),
      effectiveStepEnvironment('runtime_cleanup', 'stable', subject.runnerTemp, workflow),
    ]);

    expect(() => assertConsistentStepEnvironments(environments, expected)).toThrow('deeply equal');
  });

  it.each([
    ['stable', '0.0.0'],
    ['alpha', '0.0.1-alpha.1'],
  ])(
    'runs standalone and wrapper TUI checks with the %s install/data roots',
    async (channel, version) => {
      const subject = await createFixture();
      subject.extraEnvironment = {
        ...(await effectiveStepEnvironment('tui_acceptance', channel, subject.runnerTemp)),
        CHANNEL_VERSION: version,
        TEST_TARGET: `${process.platform}-${process.arch}`,
        NODE_LOG: join(subject.root, 'node.log'),
        PTY_CALLS: join(subject.root, 'pty-calls.log'),
        REVO_ACCEPTANCE_API_URL: 'http://127.0.0.1:33211/graphql',
        GITHUB_RUN_ID: '12345',
      };
      await prepareTuiRuntime(subject, channel);

      const result = await runBash(subject, await stepScript('tui_acceptance', channel));
      expect(result.code).toBe(0);
      const ptyCalls = (
        await readFile(requiredEnvironmentValue(subject.extraEnvironment, 'PTY_CALLS'), 'utf8')
      )
        .trim()
        .split('\n');
      const expectedDataRoot = join(subject.extraEnvironment.REVO_DATA_DIR, 'tui');
      const tui = join(
        subject.extraEnvironment.REVO_INSTALL_ROOT,
        channel,
        'package',
        version,
        `${process.platform}-${process.arch}`,
        'node_modules',
        '@revisium',
        'revo-tui',
        'bin',
        'revo-tui.js',
      );
      const launcher = join(subject.extraEnvironment.REVO_INSTALL_ROOT, channel, 'current', 'revo');

      expect(result.code).toBe(0);
      expect(ptyCalls).toHaveLength(4);
      expect(ptyCalls.every((call) => call.includes(`--data-dir ${expectedDataRoot}`))).toBe(true);
      expect(
        ptyCalls.every((call) => call.includes('--api-url http://127.0.0.1:33211/graphql')),
      ).toBe(true);
      expect(ptyCalls.slice(0, 3).every((call) => call.includes(`--executable ${tui}`))).toBe(true);
      expect(ptyCalls.at(-1)).toContain(`--executable ${launcher}`);
      expect(ptyCalls.at(-1)).toContain('-- tui');
      expect(
        await readFile(requiredEnvironmentValue(subject.extraEnvironment, 'NODE_LOG'), 'utf8'),
      ).toContain('release-acceptance-12345-');
    },
  );

  it.each(['stable', 'alpha'])(
    'cleans up the %s runtime using the matching install root',
    async (channel) => {
      const subject = await createFixture();
      subject.extraEnvironment = await effectiveStepEnvironment(
        'runtime_cleanup',
        channel,
        subject.runnerTemp,
      );
      await prepareCleanupRuntime(subject, channel);

      const result = await runBash(subject, await stepScript('runtime_cleanup', channel));
      expect(result.code).toBe(0);
      const calls = (await readFile(subject.launcherCalls, 'utf8')).trim().split('\n');

      expect(result.code).toBe(0);
      expect(result.output).toContain('Server is stopped.');
      expect(calls).toEqual([
        `${channel}|127.0.0.1|33211|${subject.extraEnvironment.REVO_INSTALL_ROOT}|${subject.extraEnvironment.REVO_DATA_DIR}|server stop`,
        `${channel}|127.0.0.1|33211|${subject.extraEnvironment.REVO_INSTALL_ROOT}|${subject.extraEnvironment.REVO_DATA_DIR}|server status`,
      ]);
    },
  );
});

async function lifecycleStep(channel: string): Promise<string> {
  return stepScript('lifecycle', channel);
}

async function stepScript(stepId: string, channel: string): Promise<string> {
  const workflow = await readFile(workflowPath, 'utf8');
  const lines = workflow.split('\n');
  const consumerIndex = lines.findIndex((line) => line === '  consumer:');
  const consumerEnd = lines.findIndex(
    (line, index) => index > consumerIndex && /^  [a-z][\w-]*:$/.test(line),
  );
  const consumer = lines.slice(consumerIndex, consumerEnd < 0 ? undefined : consumerEnd);
  const stepIdIndex = consumer.findIndex((line) => line === `        id: ${stepId}`);
  if (stepIdIndex < 0) {
    throw new Error(`consumer step id ${stepId} is missing`);
  }
  let blockStart = stepIdIndex;
  while (blockStart > 0 && !/^      - name:/.test(consumer[blockStart] ?? '')) {
    blockStart -= 1;
  }
  const blockEnd = consumer.findIndex(
    (line, index) => index > blockStart && /^      - name:/.test(line),
  );
  const stepLines = consumer.slice(blockStart, blockEnd < 0 ? undefined : blockEnd);
  const runStart = stepLines.findIndex((line) => line === '        run: |');
  if (runStart < 0) {
    throw new Error(`consumer step ${stepId} run block is missing`);
  }
  const scriptLines: string[] = [];
  for (const line of stepLines.slice(runStart + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) {
      break;
    }
    scriptLines.push(line.startsWith('          ') ? line.slice(10) : '');
  }
  return scriptLines
    .join('\n')
    .replaceAll('${{ inputs.channel }}', channel)
    .replaceAll('${{ matrix.target }}', `${process.platform}-${process.arch}`)
    .replaceAll('${{ matrix.runner }}', 'local-runner');
}

async function prepareTuiRuntime(subject: Fixture, channel: string): Promise<void> {
  const installRoot = subject.extraEnvironment.REVO_INSTALL_ROOT;
  const dataRoot = subject.extraEnvironment.REVO_DATA_DIR;
  const version = requiredEnvironmentValue(subject.extraEnvironment, 'CHANNEL_VERSION');
  const target = requiredEnvironmentValue(subject.extraEnvironment, 'TEST_TARGET');
  const nodeRoot = join(installRoot, channel, 'node', '26.8.2', target);
  const packageRoot = join(installRoot, channel, 'package', version, target);
  const launcher = join(installRoot, channel, 'current', 'revo');
  const tui = join(packageRoot, 'node_modules', '@revisium', 'revo-tui', 'bin', 'revo-tui.js');
  await mkdir(join(nodeRoot, 'bin'), { recursive: true });
  await mkdir(join(packageRoot, 'node_modules', '@revisium', 'revo-tui', 'bin'), {
    recursive: true,
  });
  await mkdir(join(installRoot, channel, 'current'), { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await writeFile(tui, '// fake TUI entrypoint\n');
  await writeFile(join(nodeRoot, 'bin', 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeLauncher(launcher);

  await writeFile(
    join(subject.root, 'tools', 'node'),
    `#!/bin/sh
set -eu
case "$*" in
  *process.platform*) printf '%s' "$TEST_TARGET" ;;
  *channel.json*) printf '%s' "$CHANNEL_VERSION" ;;
  *manifest.json*) printf '26.8.2' ;;
  *--input-type=module*) cat >/dev/null; printf '%s\\n' "$DIALOGUE_TITLE" >> "$NODE_LOG" ;;
  *) printf 'unexpected node invocation: %s\\n' "$*" >&2; exit 91 ;;
esac
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(subject.root, 'tools', 'python3'),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$PTY_CALLS"\n',
    { mode: 0o700 },
  );
}

async function prepareCleanupRuntime(subject: Fixture, channel: string): Promise<void> {
  const launcher = join(subject.extraEnvironment.REVO_INSTALL_ROOT, channel, 'current', 'revo');
  await mkdir(join(subject.extraEnvironment.REVO_INSTALL_ROOT, channel, 'current'), {
    recursive: true,
  });
  await writeLauncher(launcher);
}

async function writeLauncher(launcher: string): Promise<void> {
  await writeFile(
    launcher,
    `#!/bin/sh
printf '%s\\n' "$REVO_CHANNEL|$REVO_HOST|$REVO_PORT|$REVO_INSTALL_ROOT|$REVO_DATA_DIR|$*" >> "$LAUNCHER_CALLS"
if [ "$*" = 'server status' ]; then printf 'Server is stopped.\\n'; fi
`,
    { mode: 0o700 },
  );
  await chmod(launcher, 0o700);
}

async function effectiveStepEnvironment(
  stepId: string,
  channel: string,
  runnerTemp: string,
  workflowInput?: string,
): Promise<EffectiveEnvironment> {
  const workflow = workflowInput ?? (await readFile(workflowPath, 'utf8'));
  const lines = workflow.split('\n');
  const workflowEnvStart = lines.findIndex((line) => line === 'env:');
  const workflowEnv =
    workflowEnvStart < 0 ? {} : parseScalarMapping(lines, workflowEnvStart + 1, 2);
  const consumerIndex = lines.findIndex((line) => line === '  consumer:');
  if (consumerIndex < 0) {
    throw new Error('consumer job is missing');
  }
  const consumerEnd = lines.findIndex(
    (line, index) => index > consumerIndex && /^  [a-z][\w-]*:$/.test(line),
  );
  const jobLines = lines.slice(consumerIndex, consumerEnd < 0 ? undefined : consumerEnd);
  const jobEnvStart = jobLines.findIndex((line) => line === '    env:');
  if (jobEnvStart < 0) {
    throw new Error('consumer job env is missing');
  }
  const jobEnv = parseScalarMapping(jobLines, jobEnvStart + 1, 6);

  const stepStart = jobLines.findIndex((line) => line === `        id: ${stepId}`);
  if (stepStart < 0) {
    throw new Error(`consumer step id ${stepId} is missing`);
  }
  let blockStart = stepStart;
  while (blockStart > 0 && !/^      - name:/.test(jobLines[blockStart] ?? '')) {
    blockStart -= 1;
  }
  if (!/^      - name:/.test(jobLines[blockStart] ?? '')) {
    throw new Error(`step ${stepId} has no name`);
  }
  const blockEndRelative = jobLines.findIndex(
    (line, index) => index > blockStart && /^      - name:/.test(line),
  );
  const stepLines = jobLines.slice(blockStart, blockEndRelative < 0 ? undefined : blockEndRelative);
  const stepEnvStart = stepLines.findIndex((line) => line === '        env:');
  if (stepEnvStart < 0) {
    throw new Error(`step ${stepId} env is missing`);
  }
  const stepEnv = parseScalarMapping(stepLines, stepEnvStart + 1, 10);

  const resolve = (value: string): string =>
    value.replaceAll('${{ inputs.channel }}', channel).replaceAll('${{ runner.temp }}', runnerTemp);
  const effective = Object.fromEntries(
    Object.entries({ ...workflowEnv, ...jobEnv, ...stepEnv }).map(([key, value]) => [
      key,
      resolve(value),
    ]),
  );
  return {
    REVO_CHANNEL: requiredEnvironmentValue(effective, 'REVO_CHANNEL'),
    REVO_HOST: requiredEnvironmentValue(effective, 'REVO_HOST'),
    REVO_PORT: requiredEnvironmentValue(effective, 'REVO_PORT'),
    REVO_INSTALL_ROOT: requiredEnvironmentValue(effective, 'REVO_INSTALL_ROOT'),
    REVO_DATA_DIR: requiredEnvironmentValue(effective, 'REVO_DATA_DIR'),
    HOME: requiredEnvironmentValue(effective, 'HOME'),
  };
}

function requiredEnvironmentValue(environment: Record<string, string>, key: string): string {
  const value = environment[key];
  if (value === undefined) {
    throw new Error(`required workflow environment value ${key} is missing`);
  }
  return value;
}

function assertConsistentStepEnvironments(
  environments: Record<string, string>[],
  expected: Record<string, string>,
): void {
  expect(environments).toEqual([expected, expected, expected]);
}

function overrideStepEnvironment(
  workflow: string,
  stepId: string,
  key: string,
  value: string,
): string {
  const step = `        id: ${stepId}\n`;
  const stepStart = workflow.indexOf(step);
  if (stepStart < 0) {
    throw new Error(`step ${stepId} is missing`);
  }
  const setting = `          ${key}: `;
  const settingStart = workflow.indexOf(setting, stepStart);
  if (settingStart < 0) {
    throw new Error(`${key} is missing from step ${stepId}`);
  }
  const valueStart = settingStart + setting.length;
  const valueEnd = workflow.indexOf('\n', valueStart);
  return workflow.slice(0, valueStart) + value + workflow.slice(valueEnd);
}

function parseScalarMapping(
  lines: string[],
  start: number,
  indentation: number,
): Record<string, string> {
  const result: Record<string, string> = {};
  const expression = new RegExp(`^ {${indentation}}([A-Z0-9_]+): (.+)$`);
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }
    if (line.trim() === '') {
      continue;
    }
    const currentIndentation = line.match(/^ */)?.[0].length ?? 0;
    if (currentIndentation < indentation) {
      break;
    }
    if (currentIndentation > indentation) {
      throw new Error('nested workflow environment values are unsupported by this fixture reader');
    }
    const match = expression.exec(line);
    if (!match) {
      throw new Error(`unsupported workflow environment mapping: ${line.trim()}`);
    }
    const key = match[1];
    const value = match[2];
    if (key === undefined || value === undefined) {
      throw new Error(`incomplete workflow environment mapping: ${line.trim()}`);
    }
    result[key] =
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
        ? value.slice(1, -1)
        : value;
  }
  return result;
}

interface Fixture {
  root: string;
  runnerTemp: string;
  curlUrls: string;
  launcherCalls: string;
  githubEnv: string;
  tarball: string;
  extraEnvironment: EffectiveEnvironment;
}

interface EffectiveEnvironment extends Record<string, string> {
  REVO_CHANNEL: string;
  REVO_HOST: string;
  REVO_PORT: string;
  REVO_INSTALL_ROOT: string;
  REVO_DATA_DIR: string;
  HOME: string;
}

async function createFixture(
  extraEnvironment: Record<string, string> = {},
  packageVersion = '0.0.0',
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'revo-release-acceptance-workflow-'));
  roots.push(root);
  const runnerTemp = join(root, 'runner-temp');
  const acceptance = join(runnerTemp, 'revo-acceptance');
  const bundle = join(acceptance, 'revo-bundle');
  const tui = join(acceptance, 'tui');
  const tools = join(root, 'tools');
  await mkdir(bundle, { recursive: true });
  await mkdir(tui, { recursive: true });
  await mkdir(tools, { recursive: true });

  const tarball = join(root, 'revo-tui.tgz');
  const tarballBytes = Buffer.from('synthetic verified TUI archive\n');
  await writeFile(tarball, tarballBytes);
  const tarballSha = createHash('sha256').update(tarballBytes).digest('hex');
  const tuiName = 'revisium-revo-tui-0.0.0.tgz';
  const tuiUrl = `https://127.0.0.1:8443/tui/${tarballSha}/${tuiName}?sha256=${tarballSha}`;

  await writeFile(
    join(tui, 'release-package-manifest.json'),
    JSON.stringify({
      package: { filename: tuiName },
    }),
  );
  await writeFile(
    join(bundle, 'package.json'),
    JSON.stringify({
      dependencies: { '@revisium/revo-tui': tuiUrl },
    }),
  );
  await writeFile(join(bundle, 'channel.json'), JSON.stringify({ version: packageVersion }));
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ toolchain: { node: '26.8.2' } }));
  await writeFile(join(bundle, 'install.sh'), '#!/bin/sh\n');

  const curlPath = join(tools, 'curl');
  await writeFile(
    curlPath,
    `#!/bin/sh
set -eu
output=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$url" >> "$CURL_URLS"
case "$url" in
  https://127.0.0.1:8443/tui/*) cp "$TUI_TARBALL" "$output" ;;
  */graphql)
    graphql_count_file="$CURL_URLS.graphql-count"
    graphql_count=0
    if [ -f "$graphql_count_file" ]; then graphql_count="$(cat "$graphql_count_file")"; fi
    graphql_count="$((graphql_count + 1))"
    printf '%s\\n' "$graphql_count" > "$graphql_count_file"
    if [ "\${CURL_GRAPHQL_ERRORS:-0}" = 1 ] || [ "\${CURL_GRAPHQL_FAIL_AT:-0}" = "$graphql_count" ]; then
      printf '%s\\n' '{"errors":[{"message":"synthetic failure"}]}' > "$output"
    else
      printf '%s\\n' '{"data":{"__typename":"Query"}}' > "$output"
    fi
    ;;
  */)
    if [ "\${ADMIN_HTTP_ERRORS:-0}" = 1 ]; then exit 22; fi
    printf '%s\\n' '<html>Revo Admin</html>' > "$output"
    ;;
  *) printf '%s\\n' '<html>Revo Admin</html>' > "$output" ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(curlPath, 0o700);

  const target = `${process.platform}-${process.arch}`;
  const installScript = `#!/bin/sh
set -eu
target='${target}'
node_root="$REVO_INSTALL_ROOT/$REVO_CHANNEL/node/26.8.2/$target"
package_root="$REVO_INSTALL_ROOT/$REVO_CHANNEL/package/${packageVersion}/$target"
mkdir -p "$node_root/bin" "$package_root/dist/bin" "$REVO_INSTALL_ROOT/$REVO_CHANNEL/current"
printf '#!/bin/sh\\nexit 0\\n' > "$node_root/bin/node"
chmod +x "$node_root/bin/node"
: > "$package_root/dist/bin/revo.js"
cat > "$REVO_INSTALL_ROOT/$REVO_CHANNEL/current/revo" <<'LAUNCHER'
#!/bin/sh
printf '%s\\n' "$REVO_CHANNEL|$REVO_HOST|$REVO_PORT|$REVO_INSTALL_ROOT|$REVO_DATA_DIR|$*" >> "$LAUNCHER_CALLS"
if [ "\${SERVER_START_FAIL:-0}" = 1 ] && [ "\${1:-}" = server ] && [ "\${2:-}" = start ]; then exit 9; fi
if [ "\${1:-}" = server ] && [ "\${2:-}" = start ]; then
  start_count=0
  if [ -f "$REVO_INSTALL_ROOT/start-count" ]; then start_count="$(cat "$REVO_INSTALL_ROOT/start-count")"; fi
  start_count="$((start_count + 1))"
  printf '%s\\n' "$start_count" > "$REVO_INSTALL_ROOT/start-count"
  if [ "\${SERVER_START_FAIL_AT:-0}" = "$start_count" ]; then exit 9; fi
  echo 'Server is already running. https://attacker.invalid/'
fi
exit 0
LAUNCHER
chmod +x "$REVO_INSTALL_ROOT/$REVO_CHANNEL/current/revo"
`;
  await writeFile(join(bundle, 'install.sh'), installScript, { mode: 0o600 });

  return {
    root,
    runnerTemp,
    curlUrls: join(root, 'curl-urls.log'),
    launcherCalls: join(root, 'launcher-calls.log'),
    githubEnv: join(root, 'github-env'),
    tarball,
    extraEnvironment: {
      REVO_CHANNEL: 'stable',
      REVO_HOST: '127.0.0.1',
      REVO_PORT: '33211',
      REVO_INSTALL_ROOT: join(runnerTemp, 'revo-install'),
      REVO_DATA_DIR: join(runnerTemp, 'revo-data'),
      HOME: join(runnerTemp, 'revo-home'),
      ...extraEnvironment,
    },
  };
}

function runBash(
  subjectFixture: Fixture,
  script: string,
): Promise<{ code: number | null; output: string }> {
  const root = subjectFixture.root;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-c', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${join(root, 'tools')}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: subjectFixture.runnerTemp,
        GITHUB_ENV: subjectFixture.githubEnv,
        CURL_URLS: subjectFixture.curlUrls,
        LAUNCHER_CALLS: subjectFixture.launcherCalls,
        TUI_TARBALL: subjectFixture.tarball,
        TUI_TARBALL_SHA256: createHash('sha256')
          .update('synthetic verified TUI archive\n')
          .digest('hex'),
        ...subjectFixture.extraEnvironment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise({ code, output }));
  });
}
