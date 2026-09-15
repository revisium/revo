// oxlint-disable no-unsafe-type-assertion, typescript/unbound-method -- dynamic builder fixture
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';

import {
  bootstrapPolicy,
  embeddedBootstrap,
  installerBuilderScenario,
} from './installer-builder-scenario.js';
import { pnpmReleaseManifestFixture } from './release-manifest-fixture.js';

type Builder = { buildInstaller(input: unknown): string };
type Data = { readonly channel?: string };

const run = (command: string, args: readonly string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed`)),
    );
  });

export async function portableToolchain(channel: 'stable' | 'alpha' = 'stable') {
  const root = await mkdtemp(join(tmpdir(), 'revo-c3b-'));
  const tools = join(root, 'tools');
  const nodeSource = join(root, 'node');
  const pnpmSource = join(root, 'pnpm');
  await mkdir(join(nodeSource, 'bin'), { recursive: true });
  await mkdir(join(pnpmSource, 'dist'), { recursive: true });
  await writeFile(join(nodeSource, 'bin', 'node'), '#!/bin/sh\nexec "$REVO_TEST_NODE" "$@"\n');
  await chmod(join(nodeSource, 'bin', 'node'), 0o755);
  await writeFile(join(pnpmSource, 'pnpm'), "#!/bin/sh\nprintf '12.4.1\\n'\n");
  await chmod(join(pnpmSource, 'pnpm'), 0o755);
  const nodeFormat = process.platform === 'darwin' ? 'tar.gz' : 'tar.xz';
  const nodeArchive = join(root, `node.${nodeFormat}`);
  const pnpmArchive = join(root, 'pnpm.tar.gz');
  const tar = process.platform === 'darwin' ? '/usr/bin/tar' : '/bin/tar';
  await run(tar, [nodeFormat === 'tar.gz' ? '-czf' : '-cJf', nodeArchive, '-C', nodeSource, '.']);
  await run(tar, ['-czf', pnpmArchive, '-C', pnpmSource, '.']);
  const nodeSha = createHash('sha256')
    .update(await readFile(nodeArchive))
    .digest('hex');
  const pnpmSha = createHash('sha256')
    .update(await readFile(pnpmArchive))
    .digest('hex');
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const input = pnpmReleaseManifestFixture({
    channel,
    version: channel === 'stable' ? '2.7.1' : '2.7.1-alpha.1',
    versions: { core: '4.3.2', admin: '5.4.3', node: process.versions.node, pnpm: '12.4.1' },
  });
  const manifest = {
    ...input.manifest,
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
  const payload = `import { readFile } from 'node:fs/promises';\nimport { dirname } from 'node:path';\nimport { runInstallMode } from ${JSON.stringify(new URL('../../../installer/node-bootstrap.mjs', import.meta.url).href)};\nconst archive = await readFile(process.env.REVO_TEST_PNPM_ARCHIVE);\nawait runInstallMode({ dataPath: process.argv[2], receiptPath: process.env.REVO_RECEIPT_PATH, target: process.env.REVO_NODE_TARGET, archiveSha256: process.env.REVO_NODE_ARCHIVE_SHA256, channelRoot: process.env.REVO_INSTALL_ROOT, privateNodeRoot: dirname(process.execPath), scratch: process.env.REVO_INSTALL_SCRATCH, request: async () => ({ status: 200, headers: new Headers({ 'content-length': String(archive.length) }), body: (async function* () { yield archive; })() }) });`;
  const { buildInstaller } = await vi.importActual<Builder>(
    new URL('../../../installer/build-installer.mjs', import.meta.url).href,
  );
  const script = buildInstaller({
    ...input,
    bootstrapPolicy,
    manifest,
    template: await installerTemplateBytes(),
    payload,
  });
  await mkdir(tools);
  const calls = join(root, 'curl.calls');
  await writeFile(
    join(tools, 'curl'),
    '#!/bin/sh\nprintf x >>"$REVO_CURL_CALLS"\nwhile [ -n "${REVO_CURL_HOLD:-}" ] && [ -e "$REVO_CURL_HOLD" ]; do sleep 0.02; done\nwhile [ "$#" -gt 0 ]; do [ "$1" = --output ] && { shift; out=$1; }; shift; done\ncp "$REVO_FIXTURE_NODE_ARCHIVE" "$out"\n',
  );
  await chmod(join(tools, 'curl'), 0o755);
  await writeFile(join(root, 'install.sh'), script, { mode: 0o700 });
  const startInstaller = (extra: Record<string, string> = {}) => {
    let child!: ChildProcess;
    const finish = new Promise<number>((resolve) => {
      child = spawn('/bin/sh', [join(root, 'install.sh')], {
        env: {
          ...process.env,
          HOME: root,
          PATH: `${tools}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          REVO_INSTALL_ROOT: join(root, 'state'),
          REVO_FIXTURE_NODE_ARCHIVE: nodeArchive,
          REVO_CURL_CALLS: calls,
          REVO_TEST_PNPM_ARCHIVE: pnpmArchive,
          REVO_TEST_NODE: process.execPath,
          ...extra,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.once('close', (code) => resolve(code ?? 1));
    });
    return { child, finish };
  };
  const runInstaller = () => startInstaller().finish;
  return { root, script, runInstaller, startInstaller, calls, nodeArchive, pnpmArchive };
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
  const payload = await readFile(
    new URL('../../../installer/node-bootstrap.mjs', import.meta.url),
    'utf8',
  );
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
