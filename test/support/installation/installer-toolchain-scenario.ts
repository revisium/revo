// oxlint-disable no-unsafe-type-assertion, typescript/unbound-method -- dynamic builder fixture
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';

import {
  bootstrapPolicy,
  embeddedBootstrap,
  installerBuilderScenario,
} from './installer-builder-scenario.js';
import { packageArtifactScenario } from './package-artifact-scenario.js';
import { pnpmReleaseManifestFixture } from './release-manifest-fixture.js';

type Builder = { buildInstaller(input: unknown): string };
type Data = { readonly channel?: string };
let cachedNodeArchive: Buffer | undefined;
let cachedPnpmArchive: Buffer | undefined;

const run = (command: string, args: readonly string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', env: { ...process.env, XZ_OPT: '-0' } });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed`)),
    );
  });

export async function portableToolchain(
  channel: 'stable' | 'alpha' = 'stable',
  releaseVersion?: string,
  activationProbe = false,
  realActivation = false,
  installRoot?: string,
) {
  const root = await mkdtemp(join(tmpdir(), 'revo-c3b-'));
  const tools = join(root, 'tools');
  const nodeSource = join(root, 'node');
  const pnpmSource = join(root, 'pnpm');
  await mkdir(join(nodeSource, 'bin'), { recursive: true });
  await mkdir(join(pnpmSource, 'dist'), { recursive: true });
  await copyFile(process.execPath, join(nodeSource, 'bin', 'node'));
  await chmod(join(nodeSource, 'bin', 'node'), 0o755);
  await writeFile(
    join(pnpmSource, 'pnpm'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then printf \'12.4.1\\n\'; else trap \'[ -z "${REVO_PNPM_TERMINATED:-}" ] || : >"$REVO_PNPM_TERMINATED"; exit 143\' HUP INT TERM; [ -z "${REVO_PNPM_STARTED:-}" ] || : >"$REVO_PNPM_STARTED"; while [ -n "${REVO_PNPM_HOLD:-}" ] && [ -e "$REVO_PNPM_HOLD" ]; do :; done; [ -z "${REVO_PNPM_INSTALLS:-}" ] || : >>"$REVO_PNPM_INSTALLS"; [ -n "${REVO_PNPM_FAIL:-}" ] && exit 7 || :; printf \'{"name":"pnpm:install"}\\n\'; : >"$PWD/install-complete"; fi\n',
  );
  await chmod(join(pnpmSource, 'pnpm'), 0o755);
  await writeFile(
    join(pnpmSource, 'pnpm'),
    `${await readFile(join(pnpmSource, 'pnpm'), 'utf8')}printf '%s/bin/node\\n' "$REVO_PRIVATE_NODE_ROOT" >"$REVO_PNPM_NODE_RECORD"\n`,
  );
  await writeFile(
    join(pnpmSource, 'pnpm'),
    '#!/bin/sh\nexec "$REVO_PRIVATE_NODE_ROOT/bin/node" "${0%/*}/launcher.mjs" "$@"\n',
  );
  await chmod(join(pnpmSource, 'pnpm'), 0o755);
  await writeFile(
    join(pnpmSource, 'launcher.mjs'),
    "import { appendFile, access, writeFile } from 'node:fs/promises';\nconst codes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };\nfor (const [signal, code] of Object.entries(codes)) process.once(signal, async () => { if (process.env.REVO_PNPM_TERMINATED) await writeFile(process.env.REVO_PNPM_TERMINATED, 'ack\\n'); process.exit(code); });\nif (process.argv[2] === '--version') process.stdout.write('12.4.1\\n');\nelse { if (process.env.REVO_PNPM_STARTED) await writeFile(process.env.REVO_PNPM_STARTED, 'ready\\n'); while (process.env.REVO_PNPM_HOLD && await access(process.env.REVO_PNPM_HOLD).then(() => true, () => false)) await new Promise((resolve) => setTimeout(resolve, 10)); if (process.env.REVO_PNPM_INSTALLS) await appendFile(process.env.REVO_PNPM_INSTALLS, 'install\\n'); if (process.env.REVO_PNPM_NODE_RECORD) await writeFile(process.env.REVO_PNPM_NODE_RECORD, `${process.execPath}\\n`); if (process.env.REVO_PNPM_FAIL) process.exit(7); process.stdout.write('{\"name\":\"pnpm:install\"}\\n'); await writeFile(`${process.cwd()}/install-complete`, 'done\\n'); }\n",
  );
  const nodeFormat = process.platform === 'darwin' ? 'tar.gz' : 'tar.xz';
  const nodeArchive = join(root, `node.${nodeFormat}`);
  const pnpmArchive = join(root, 'pnpm.tar.gz');
  const tar = process.platform === 'darwin' ? '/usr/bin/tar' : '/bin/tar';
  if (cachedNodeArchive === undefined) {
    if (nodeFormat === 'tar.gz') {
      await run(tar, ['-czf', nodeArchive, '-C', nodeSource, '.']);
    } else {
      const rawArchive = `${nodeArchive}.tar`;
      await run(tar, ['-cf', rawArchive, '-C', nodeSource, '.']);
      await run('xz', ['-0', rawArchive]);
      await rename(`${rawArchive}.xz`, nodeArchive);
    }
    cachedNodeArchive = await readFile(nodeArchive);
  } else {
    await writeFile(nodeArchive, cachedNodeArchive);
  }
  if (cachedPnpmArchive === undefined) {
    await run(tar, ['-czf', pnpmArchive, '-C', pnpmSource, '.']);
    cachedPnpmArchive = await readFile(pnpmArchive);
  } else {
    await writeFile(pnpmArchive, cachedPnpmArchive);
  }
  const nodeSha = createHash('sha256')
    .update(await readFile(nodeArchive))
    .digest('hex');
  let pnpmSha = createHash('sha256')
    .update(await readFile(pnpmArchive))
    .digest('hex');
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const packages = await packageArtifactScenario({
    channel,
    ...(releaseVersion === undefined ? {} : { version: releaseVersion }),
    ...(activationProbe ? { activationProbe: true } : {}),
    ...(realActivation ? { realActivation: true } : {}),
  });
  const input = pnpmReleaseManifestFixture({
    channel,
    version: packages.plan.release.version,
    versions: {
      core: packages.plan.components.core.version,
      admin: packages.plan.components.admin.version,
      node: packages.plan.toolchain.node,
      pnpm: packages.plan.toolchain.pnpm,
    },
  });
  if (realActivation) {
    const descriptor = input.manifest.toolchain.pnpmArchives.find(
      (item) => item.platform === platform && item.arch === arch,
    );
    if (descriptor === undefined) {
      throw new Error('fixture omitted pnpm archive');
    }
    const response = await fetch(descriptor.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      throw new Error(`pnpm archive download failed: ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== descriptor.sha256) {
      throw new Error('pnpm archive digest mismatch');
    }
    await writeFile(pnpmArchive, bytes);
    pnpmSha = digest;
  }
  const manifest = {
    ...input.manifest,
    release: packages.plan.release,
    components: packages.plan.components,
    artifacts: packages.plan.artifacts,
    toolchain: {
      ...input.manifest.toolchain,
      nodeArchives: input.manifest.toolchain.nodeArchives.map((item) =>
        item.platform === platform && item.arch === arch ? { ...item, sha256: nodeSha } : item,
      ),
      pnpmArchives: input.manifest.toolchain.pnpmArchives.map((item) =>
        item.platform === platform && item.arch === arch ? { ...item, sha256: pnpmSha } : item,
      ),
    },
  };
  const { buildInstaller } = await vi.importActual<Builder>(
    new URL('../../../installer/build-installer.mjs', import.meta.url).href,
  );
  const { buildPayload } = await vi.importActual<{
    buildPayload: (options?: { entry?: string | undefined }) => Promise<string>;
  }>(new URL('../../../installer/build-payload.mjs', import.meta.url).href);
  const payload = await buildPayload({
    entry: !realActivation
      ? new URL('./preparation-driver.mjs', import.meta.url).pathname
      : undefined,
  });
  const script = buildInstaller({
    ...input,
    bootstrapPolicy,
    manifest,
    template: await installerTemplateBytes(),
    payload,
  });
  await mkdir(tools);
  const responses = Object.fromEntries(
    Object.entries(packages.plan.artifacts).map(([name, descriptor]) => [
      descriptor.url,
      Buffer.from(packages.bytes[name as keyof typeof packages.bytes]).toString('base64'),
    ]),
  );
  const pnpmDescriptor = manifest.toolchain.pnpmArchives.find(
    (item) => item.platform === platform && item.arch === arch,
  );
  if (pnpmDescriptor === undefined) {
    throw new Error('fixture omitted pnpm archive');
  }
  responses[pnpmDescriptor.url] = (await readFile(pnpmArchive)).toString('base64');
  const responseMap = join(root, 'responses.json');
  await writeFile(responseMap, JSON.stringify(responses), { mode: 0o600 });
  const preload = join(root, 'fetch-preload.mjs');
  const hookUrl = new URL('./activation-barrier.mjs', import.meta.url).href;
  await writeFile(
    preload,
    `import cp from 'node:child_process';\nimport { syncBuiltinESMExports } from 'node:module';\nimport { appendFileSync, readFileSync } from 'node:fs';\nimport { resolve } from 'node:path';\nconst originalSpawn = cp.spawn;\ncp.spawn = (command, args, options) => { const mode = process.env.REVO_TEST_ACTIVATION_FAULT; const text = [String(command), ...(args ?? [])].join(' '); if (text.includes('pnpm') && text.includes(' install')) appendFileSync(process.env.REVO_PNPM_CALLS, JSON.stringify({ command: 'pnpm', args: (args ?? []).filter((arg) => /install|frozen|prod/.test(String(arg))).length }) + '\\n'); const match = mode && args?.length === 2 && typeof options?.cwd === 'string' && args[0] === resolve(options.cwd, 'dist/bin/revo-install-activate.js'); if (match) { const hook = new URL(${JSON.stringify(hookUrl)}); hook.searchParams.set('mode', mode); hook.searchParams.set('root', process.env.REVO_INSTALL_ROOT); return originalSpawn(command, ['--import', hook.href, ...args], options); } return originalSpawn(command, args, options); };\nsyncBuiltinESMExports();\nconst map = JSON.parse(readFileSync(process.env.REVO_TEST_RESPONSES, 'utf8'));\nglobalThis.fetch = async (url) => { appendFileSync(process.env.REVO_FETCH_CALLS, \`\${url}\\n\`); const encoded = map[url]; if (encoded === undefined) return new Response(null, { status: 404 }); const body = Buffer.from(encoded, 'base64'); return { status: 200, headers: new Headers({ 'content-length': String(body.length) }), body: (async function* () { yield body; })() }; };\n`,
    { mode: 0o600 },
  );
  const calls = join(root, 'curl.calls');
  const fetchCalls = join(root, 'fetch.calls');
  await writeFile(fetchCalls, '', { mode: 0o600 });
  const pnpmStarted = join(root, 'pnpm.started');
  const pnpmTerminated = join(root, 'pnpm.terminated');
  const pnpmInstalls = join(root, 'pnpm.installs');
  const pnpmCalls = join(root, 'pnpm.calls');
  await writeFile(pnpmCalls, '', { mode: 0o600 });
  const pnpmNodeRecord = join(root, 'pnpm.node');
  await writeFile(
    join(tools, 'curl'),
    '#!/bin/sh\n[ -z "${REVO_CURL_OFFLINE:-}" ] || exit 1\nprintf x >>"$REVO_CURL_CALLS"\nwhile [ -n "${REVO_CURL_HOLD:-}" ] && [ -e "$REVO_CURL_HOLD" ]; do :; done\nwhile [ "$#" -gt 0 ]; do [ "$1" = --output ] && { shift; out=$1; }; shift; done\ncp "$REVO_FIXTURE_NODE_ARCHIVE" "$out"\n',
  );
  await chmod(join(tools, 'curl'), 0o755);
  await writeFile(join(root, 'install.sh'), script, { mode: 0o700 });
  const startInstaller = (extra: Record<string, string> = {}) => {
    let child!: ChildProcess;
    let stderr = '';
    const finish = new Promise<number>((resolve) => {
      child = spawn('/bin/sh', [join(root, 'install.sh')], {
        env: {
          ...process.env,
          HOME: root,
          PATH: `${tools}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          REVO_INSTALL_ROOT: installRoot ?? join(root, 'state'),
          REVO_FIXTURE_NODE_ARCHIVE: nodeArchive,
          REVO_CURL_CALLS: calls,
          REVO_TEST_PNPM_ARCHIVE: pnpmArchive,
          REVO_TEST_NODE: process.execPath,
          REVO_TEST_RESPONSES: responseMap,
          REVO_FETCH_CALLS: fetchCalls,
          REVO_PNPM_STARTED: pnpmStarted,
          REVO_PNPM_TERMINATED: pnpmTerminated,
          REVO_PNPM_INSTALLS: pnpmInstalls,
          REVO_PNPM_CALLS: pnpmCalls,
          REVO_PNPM_NODE_RECORD: pnpmNodeRecord,
          NODE_OPTIONS: `--import=${preload}`,
          ...extra,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < 2048) {
          stderr += chunk.slice(0, 2048 - stderr.length);
        }
      });
      child.once('exit', (code) => {
        if (code !== 0 && stderr.length > 0) {
          console.error(stderr.replaceAll(root, '<fixture>'));
          void readdir(join(extra.REVO_INSTALL_ROOT ?? join(root, 'state'), channel), {
            withFileTypes: true,
          })
            .then(async (entries) => {
              const logs = [];
              for (const entry of entries.filter((item) => item.name.startsWith('.attempt.'))) {
                const scratch = join(
                  extra.REVO_INSTALL_ROOT ?? join(root, 'state'),
                  channel,
                  entry.name,
                  'runtime',
                  'scratch',
                );
                for (const request of await readdir(scratch, { withFileTypes: true }).catch(
                  () => [],
                )) {
                  if (!request.name.startsWith('.activation-request-')) continue;
                  const text = await readFile(
                    join(scratch, request.name, 'result.log'),
                    'utf8',
                  ).catch(() => '');
                  if (text)
                    logs.push({
                      schema: text.includes('schemaVersion'),
                      status: /"status":"(?:activated|unchanged)"/u.test(text),
                      generation: /"generationId":"[a-f0-9]{64}"/u.test(text),
                    });
                }
              }
              console.error(JSON.stringify({ exit: code, helperResults: logs }));
            })
            .catch(() => undefined);
          const identity = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
          const targetNode = join(
            extra.REVO_INSTALL_ROOT ?? join(root, 'state'),
            channel,
            'node',
            process.versions.node,
            identity,
            'bin',
            'node',
          );
          void lstat(targetNode).then(
            (info) => console.error(`node target mode: ${(info.mode & 0o777).toString(8)}`),
            () => console.error('node target: missing'),
          );
        }
        resolve(code ?? 1);
      });
    });
    return { child, finish };
  };
  const runInstaller = () => startInstaller().finish;
  const attempts = async () =>
    (await readdir(join(root, 'state', channel), { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.name.startsWith('.attempt.') && entry.isDirectory())
      .map((entry) => join(root, 'state', channel, entry.name));
  const runTogether = () => {
    const first = startInstaller();
    const second = startInstaller();
    return Promise.all([first.finish, second.finish]);
  };
  return {
    root,
    plan: packages.plan,
    script,
    runInstaller,
    startInstaller,
    runTogether,
    attempts,
    calls,
    pnpmStarted,
    pnpmTerminated,
    pnpmInstalls,
    pnpmCalls,
    pnpmNodeRecord,
    fetchCalls,
    nodeArchive,
    pnpmArchive,
    nodeArchiveSha256: nodeSha,
    pnpmArchiveSha256: pnpmSha,
  };
}

export async function cleanupPortableToolchain(root: string) {
  await rm(root, { recursive: true, force: true });
}

export async function toolchainInstaller(channel: 'stable' | 'alpha' = 'stable') {
  const { buildInstaller } = await vi.importActual<Builder>(
    new URL('../../../installer/build-installer.mjs', import.meta.url).href,
  );
  const input = pnpmReleaseManifestFixture({
    channel,
    version: channel === 'stable' ? '2.7.1' : '2.7.1-alpha.1',
    versions: { core: '4.3.2', admin: '5.4.3', node: '26.8.2', pnpm: '12.4.1' },
  });
  const template = await installerTemplateBytes();
  const { buildPayload } = await vi.importActual<{ buildPayload: () => Promise<string> }>(
    new URL('../../../installer/build-payload.mjs', import.meta.url).href,
  );
  const payload = await buildPayload();
  return buildInstaller({ ...input, bootstrapPolicy, template, payload });
}

export async function installerData(channel?: 'stable' | 'alpha'): Promise<Data> {
  return embeddedBootstrap(await toolchainInstaller(channel)) as Data;
}

export async function nodeInstaller() {
  const { buildInstaller } = await vi.importActual<Builder>(
    new URL('../../../installer/build-installer.mjs', import.meta.url).href,
  );
  const input = installerBuilderScenario({
    core: '4.3.2',
    admin: '5.4.3',
    node: '26.8.2',
    pnpm: '12.4.1',
  });
  const template = await installerTemplateBytes();
  const payload = await readFile(
    new URL('../../../installer/node-bootstrap.mjs', import.meta.url),
    'utf8',
  );
  return buildInstaller({ ...input, template, payload });
}

export async function nodeData(): Promise<Data> {
  return embeddedBootstrap(await nodeInstaller()) as Data;
}

export async function installerTemplateBytes() {
  const script = await readFile(
    new URL('../../../installer/install.sh.in', import.meta.url),
    'utf8',
  );
  return script;
}
