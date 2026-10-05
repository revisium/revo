import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

import {
  renderInstallScript,
  type InstallPlatform,
  type ReleaseChannel,
} from '../../../installer/render-install-script.mjs';
import {
  createFixtureCertificate,
  FixtureOrigin,
  type FixtureCertificate,
  type StalledDownload,
} from './fixture-origin.js';

const run = promisify(execFile);
const NODE_VERSION = process.versions.node;
const PNPM_VERSION = '12.8.2';
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const FOREIGN_COMMAND = '#!/bin/sh\necho "not Revo"\n';

export type ReleaseAsset = 'package' | 'lockfile' | 'workspace';

export interface FixtureRelease {
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly script: string;
  assetUrl(asset: ReleaseAsset): string;
  assetPath(asset: ReleaseAsset): string;
}

export interface InstallResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunningInstall {
  readonly finished: Promise<InstallResult>;
  interrupt(): void;
  kill(): void;
}

export interface HeldDependencyInstallation {
  readonly started: Promise<void>;
  release(): void;
}

export interface ReportedPlatform {
  readonly system: string;
  readonly machine: string;
  readonly glibc?: string;
  readonly macos?: string;
}

interface Toolchains {
  readonly node: { readonly url: string; readonly sha256: Record<InstallPlatform, string> };
  readonly pnpm: { readonly url: string; readonly sha256: Record<InstallPlatform, string> };
}

export class InstallMachine {
  private toolchains: Toolchains | undefined;

  private constructor(
    private readonly root: string,
    private readonly certificate: FixtureCertificate,
    private readonly origin: FixtureOrigin,
    private readonly binDirOnPath: boolean,
  ) {}

  static async create(options: { readonly binDirOnPath?: boolean } = {}): Promise<InstallMachine> {
    const root = await mkdtemp(join(tmpdir(), 'revo-install-machine-'));
    await Promise.all(
      ['home', 'platform-bin', 'host-bin', 'control', 'build'].map((name) =>
        mkdir(join(root, name), { recursive: true }),
      ),
    );
    const certificate = await createFixtureCertificate(join(root, 'build'));
    const machine = new InstallMachine(
      root,
      certificate,
      await FixtureOrigin.start(certificate),
      options.binDirOnPath ?? false,
    );
    await machine.installHostNodeAndPnpm();
    return machine;
  }

  get home(): string {
    return join(this.root, 'home');
  }

  async publish(channel: ReleaseChannel, version: string): Promise<FixtureRelease> {
    const toolchains = await this.publishToolchains();
    const base = `/revo/${channel}/v${version}`;
    const assets: Record<ReleaseAsset, { path: string; bytes: Buffer }> = {
      package: { path: `${base}/revo-${version}.tgz`, bytes: await this.revoPackage(version) },
      lockfile: {
        path: `${base}/pnpm-lock.yaml`,
        bytes: Buffer.from(`lockfileVersion: '9.0'\n# ${channel} ${version}\n`),
      },
      workspace: { path: `${base}/pnpm-workspace.yaml`, bytes: Buffer.from('packages: []\n') },
    };
    for (const asset of Object.values(assets)) {
      this.origin.publish(asset.path, asset.bytes);
    }
    const script = renderInstallScript({
      channel,
      version,
      releaseUrl: `${this.origin.url}${base}`,
      sha256: {
        package: sha256(assets.package.bytes),
        lockfile: sha256(assets.lockfile.bytes),
        workspace: sha256(assets.workspace.bytes),
      },
      node: { version: NODE_VERSION, ...toolchains.node },
      pnpm: { version: PNPM_VERSION, ...toolchains.pnpm },
    });
    return {
      channel,
      version,
      script,
      assetPath: (asset) => assets[asset].path,
      assetUrl: (asset) => `${this.origin.url}${assets[asset].path}`,
    };
  }

  install(release: FixtureRelease): Promise<InstallResult> {
    return this.startInstall(release).finished;
  }

  startInstall(release: FixtureRelease): RunningInstall {
    const child = spawn('/bin/sh', [], {
      cwd: this.home,
      detached: true,
      env: this.installEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.stdin.end(release.script);
    const finished = new Promise<InstallResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) {
        throw new Error('installer process did not start');
      }
      process.kill(-child.pid, signal);
    };
    return {
      finished,
      interrupt: () => signalGroup('SIGINT'),
      kill: () => signalGroup('SIGKILL'),
    };
  }

  stallDownload(release: FixtureRelease, asset: ReleaseAsset): StalledDownload {
    return this.origin.stall(release.assetPath(asset));
  }

  corruptDownload(release: FixtureRelease, asset: ReleaseAsset): void {
    this.origin.corrupt(release.assetPath(asset));
  }

  removeDownload(release: FixtureRelease, asset: ReleaseAsset): void {
    this.origin.remove(release.assetPath(asset));
  }

  restoreDownload(release: FixtureRelease, asset: ReleaseAsset): void {
    this.origin.restore(release.assetPath(asset));
  }

  async holdDependencyInstallation(): Promise<HeldDependencyInstallation> {
    await run('mkfifo', [this.control('pnpm-gate')]);
    return {
      started: waitForFile(this.control('pnpm-started')),
      release: () => {
        void writeFile(this.control('pnpm-held'), 'go\n');
      },
    };
  }

  async reportPlatform(platform: ReportedPlatform): Promise<void> {
    await executable(
      join(this.root, 'platform-bin', 'uname'),
      `case "$1" in -m) echo ${quote(platform.machine)} ;; *) echo ${quote(platform.system)} ;; esac\n`,
    );
    await executable(
      join(this.root, 'platform-bin', 'getconf'),
      platform.glibc === undefined ? 'exit 1\n' : `echo ${quote(platform.glibc)}\n`,
    );
    await executable(
      join(this.root, 'platform-bin', 'sw_vers'),
      platform.macos === undefined ? 'exit 1\n' : `echo ${quote(platform.macos)}\n`,
    );
  }

  async placeForeignCommand(command: string): Promise<void> {
    await mkdir(dirname(this.commandPath(command)), { recursive: true });
    await writeFile(this.commandPath(command), FOREIGN_COMMAND, { mode: 0o755 });
  }

  async foreignCommandIntact(command: string): Promise<boolean> {
    return (await readFile(this.commandPath(command), 'utf8')) === FOREIGN_COMMAND;
  }

  downloads(fragment = ''): readonly string[] {
    return this.origin.requests().filter((path) => path.includes(fragment));
  }

  channelRoot(channel: ReleaseChannel): string {
    return join(this.home, '.local', 'share', 'revo', channel);
  }

  privateNode(channel: ReleaseChannel): string {
    return join(this.channelRoot(channel), 'node', NODE_VERSION, 'bin', 'node');
  }

  commandPath(command: string): string {
    return join(this.home, '.local', 'bin', command);
  }

  commandTarget(channel: ReleaseChannel, command: string): string {
    return join(this.channelRoot(channel), 'current', 'bin', command);
  }

  async activeVersion(channel: ReleaseChannel): Promise<string | undefined> {
    const target = await readlink(join(this.channelRoot(channel), 'current')).catch(
      () => undefined,
    );
    return target?.replace(/^versions\//u, '');
  }

  async installedVersions(channel: ReleaseChannel): Promise<readonly string[]> {
    return sortedEntries(join(this.channelRoot(channel), 'versions'));
  }

  async channelEntries(channel: ReleaseChannel): Promise<readonly string[]> {
    return sortedEntries(this.channelRoot(channel));
  }

  async installerLeftovers(channel: ReleaseChannel): Promise<readonly string[]> {
    return (await this.channelEntries(channel)).filter((entry) => entry.startsWith('.'));
  }

  async channelTree(channel: ReleaseChannel): Promise<readonly string[]> {
    return tree(this.channelRoot(channel));
  }

  async homeEntries(): Promise<readonly string[]> {
    return sortedEntries(this.home);
  }

  async commandLink(command: string): Promise<string | undefined> {
    return readlink(this.commandPath(command)).catch(() => undefined);
  }

  async runCommand(command: string, args: readonly string[]): Promise<string> {
    const { stdout } = await run(this.commandPath(command), [...args], {
      env: { HOME: this.home, PATH: SYSTEM_PATH },
    });
    return stdout.trim();
  }

  async revoInvocations(): Promise<readonly string[]> {
    return lines(this.control('revo-invocations.log'));
  }

  async hostToolInvocations(): Promise<readonly string[]> {
    return lines(this.control('host-tools.log'));
  }

  async pnpmInstalls(): Promise<readonly { args: string; node: string }[]> {
    return (await lines(this.control('pnpm-installs.log'))).map((line) => {
      const [node = '', args = ''] = line.split('|');
      return { args, node };
    });
  }

  async dispose(): Promise<void> {
    await this.origin.close();
    await rm(this.root, { recursive: true, force: true });
  }

  private installEnvironment(): NodeJS.ProcessEnv {
    const path = [
      join(this.root, 'platform-bin'),
      join(this.root, 'host-bin'),
      ...(this.binDirOnPath ? [join(this.home, '.local', 'bin')] : []),
      SYSTEM_PATH,
    ];
    return {
      CURL_CA_BUNDLE: this.certificate.certPath,
      HOME: this.home,
      LC_ALL: 'C',
      PATH: path.join(':'),
    };
  }

  private control(name: string): string {
    return join(this.root, 'control', name);
  }

  private async installHostNodeAndPnpm(): Promise<void> {
    await Promise.all(
      ['node', 'pnpm'].map((tool) =>
        executable(
          join(this.root, 'host-bin', tool),
          `echo ${tool} >> ${quote(this.control('host-tools.log'))}\nexit 97\n`,
        ),
      ),
    );
  }

  private async publishToolchains(): Promise<Toolchains> {
    if (this.toolchains !== undefined) {
      return this.toolchains;
    }
    const node = await this.publishArchives(
      `/node/v${NODE_VERSION}`,
      (platform) => `node-v${NODE_VERSION}-${platform}.tar.gz`,
      (platform) => this.nodeArchive(platform),
    );
    const pnpm = await this.publishArchives(
      `/pnpm/v${PNPM_VERSION}`,
      (platform) => `pnpm-${platform}.tar.gz`,
      () => this.pnpmArchive(),
    );
    this.toolchains = { node, pnpm };
    return this.toolchains;
  }

  private async publishArchives(
    base: string,
    name: (platform: InstallPlatform) => string,
    build: (platform: InstallPlatform) => Promise<Buffer>,
  ) {
    const publish = async (platform: InstallPlatform) => {
      const bytes = await build(platform);
      this.origin.publish(`${base}/${name(platform)}`, bytes);
      return sha256(bytes);
    };
    const [linuxX64, linuxArm64, darwinX64, darwinArm64] = await Promise.all([
      publish('linux-x64'),
      publish('linux-arm64'),
      publish('darwin-x64'),
      publish('darwin-arm64'),
    ]);
    return {
      url: `${this.origin.url}${base}`,
      sha256: {
        'linux-x64': linuxX64,
        'linux-arm64': linuxArm64,
        'darwin-x64': darwinX64,
        'darwin-arm64': darwinArm64,
      },
    };
  }

  private async nodeArchive(platform: InstallPlatform): Promise<Buffer> {
    const top = `node-v${NODE_VERSION}-${platform}`;
    return this.archive(`node-${platform}`, top, {
      [`${top}/bin/node`]: `exec ${quote(process.execPath)} "$@"\n`,
    });
  }

  private async pnpmArchive(): Promise<Buffer> {
    return this.archive('pnpm', '.', {
      pnpm: [
        `if [ "\${1:-}" = --version ]; then echo ${PNPM_VERSION}; exit 0; fi`,
        `printf '%s|%s\\n' "$(command -v node)" "$*" >> ${quote(this.control('pnpm-installs.log'))}`,
        '[ -f package.json ] && [ -f pnpm-lock.yaml ] && [ -f pnpm-workspace.yaml ] || exit 3',
        `if mv ${quote(this.control('pnpm-gate'))} ${quote(this.control('pnpm-held'))} 2>/dev/null; then`,
        `  : > ${quote(this.control('pnpm-started'))}`,
        `  read -r _ < ${quote(this.control('pnpm-held'))}`,
        'fi',
        'mkdir -p node_modules && : > node_modules/.fixture-installed',
        '',
      ].join('\n'),
    });
  }

  private async revoPackage(version: string): Promise<Buffer> {
    return this.archive(`revo-${version}`, 'package', {
      'package/package.json': `${JSON.stringify({ name: '@revisium/revo', version, type: 'module' })}\n`,
      'package/dist/bin/revo.js': [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(this.control('revo-invocations.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        `if (process.argv[2] === '--version') console.log(${JSON.stringify(version)});`,
        '',
      ].join('\n'),
    });
  }

  private async archive(
    name: string,
    top: string,
    files: Readonly<Record<string, string>>,
  ): Promise<Buffer> {
    const directory = await mkdtemp(join(this.root, 'build', `${name}-`));
    await Promise.all(
      Object.entries(files).map(async ([path, content]) => {
        const target = join(directory, path);
        await mkdir(dirname(target), { recursive: true });
        await (path.endsWith('.json') || path.endsWith('.js')
          ? writeFile(target, content)
          : executable(target, content));
      }),
    );
    const output = `${directory}.tgz`;
    await run('tar', ['-czf', output, '-C', directory, top]);
    return readFile(output);
  }
}

function byName(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}`);
  await chmod(path, 0o755);
}

async function sortedEntries(directory: string): Promise<readonly string[]> {
  return (await readdir(directory).catch(() => [])).sort(byName);
}

async function tree(directory: string, root = directory): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? [relative(root, path), ...(await tree(path, root))]
        : [relative(root, path)];
    }),
  );
  return nested.flat().sort(byName);
}

async function lines(path: string): Promise<readonly string[]> {
  const content = await readFile(path, 'utf8').catch(() => '');
  return content.split('\n').filter(Boolean);
}

async function waitForFile(path: string, deadline = Date.now() + 30_000): Promise<void> {
  try {
    await access(path);
  } catch {
    if (Date.now() >= deadline) {
      throw new Error(`fixture barrier ${path} timed out`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    return waitForFile(path, deadline);
  }
}
