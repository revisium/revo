import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  access,
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
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
import { resolveRevoLayout } from '../../../src/layout.js';
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
const SYSTEM_BIN_DIRECTORIES = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const SYSTEM_DEPENDENCY_TOOLS = [
  'apt-get',
  'dnf',
  'yum',
  'zypper',
  'pacman',
  'sudo',
  'ldconfig',
  'id',
];
const LIBRARY_LOADER_ERROR =
  'error while loading shared libraries: libatomic.so.1: cannot open shared object file: No such file or directory';
const MINIMAL_LINUX: ReportedPlatform = {
  system: 'Linux',
  machine: 'x86_64',
  glibc: 'glibc 2.35',
};
const FOREIGN_COMMAND = '#!/bin/sh\necho "not Revo"\n';
const CHANNELS: readonly ReleaseChannel[] = ['stable', 'alpha'];
const USER_PNPM_CONFIG_DIRS = [join('.config', 'pnpm'), join('Library', 'Preferences', 'pnpm')];
const IGNORE_SCRIPTS: FixturePnpmSetting = {
  variable: 'ignore_scripts',
  configKey: 'ignoreScripts',
  environment: 'pnpm_config_ignore_scripts',
  flag: 'ignore-scripts',
};
const ENGINE_STRICT: FixturePnpmSetting = {
  variable: 'engine_strict',
  configKey: 'engineStrict',
  environment: 'PNPM_CONFIG_ENGINE_STRICT',
  flag: 'engine-strict',
};

type ReleaseAsset = 'package' | 'lockfile' | 'workspace';

interface FixtureRelease {
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly script: string;
  assetUrl(asset: ReleaseAsset): string;
  assetPath(asset: ReleaseAsset): string;
}

interface InstallResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunningInstall {
  readonly finished: Promise<InstallResult>;
  interrupt(): void;
  kill(): void;
}

interface InstallRace {
  readonly firstToFinish: Promise<InstallResult>;
  readonly lastToFinish: Promise<InstallResult>;
}

interface HeldDependencyInstallation {
  readonly started: Promise<void>;
  release(): void;
}

export interface MachineOptions {
  readonly binDirOnPath?: boolean;
  readonly installRoot?: string;
  /** A private tool that fails to load a shared library, as on a minimal image. */
  readonly brokenToolchain?: 'node' | 'pnpm';
}

interface PackageManagerOptions {
  /** The install fails until `update` has refreshed the package lists, as on a fresh image. */
  readonly staleLists?: boolean;
  /** apt speaks English only under LC_ALL=C and German otherwise, as in a localized session. */
  readonly localized?: boolean;
  /** The install fails with this message, whatever the package lists hold. */
  readonly failWith?: string;
}

type UserPnpmSettingSource = 'configuration file' | 'environment';

interface ReportedPlatform {
  readonly system: string;
  readonly machine: string;
  readonly glibc?: string;
  readonly macos?: string;
}

interface FixturePnpmSetting {
  readonly variable: string;
  readonly configKey: string;
  readonly environment: string;
  readonly flag: string;
}

interface Toolchains {
  readonly node: { readonly url: string; readonly sha256: Record<InstallPlatform, string> };
  readonly pnpm: { readonly url: string; readonly sha256: Record<InstallPlatform, string> };
}

export class InstallMachine {
  private toolchains: Toolchains | undefined;

  private workingDirectory: string;

  private readonly userPnpmEnvironment: Record<string, string> = {};

  private systemPath = SYSTEM_PATH;

  private constructor(
    private readonly root: string,
    private readonly certificate: FixtureCertificate,
    private readonly origin: FixtureOrigin,
    private readonly options: MachineOptions,
  ) {
    this.workingDirectory = this.home;
  }

  static async create(options: MachineOptions = {}): Promise<InstallMachine> {
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
      options,
    );
    await machine.installHostNodeAndPnpm();
    await machine.installLibraryCache();
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
      cwd: this.workingDirectory,
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

  async killInstallDuringDependencyInstallation(release: FixtureRelease): Promise<void> {
    const pnpm = await this.holdDependencyInstallation();
    const install = this.startInstall(release);
    await pnpm.started;
    install.kill();
    await install.finished;
  }

  async startTwoInstallsAtOnce(release: FixtureRelease): Promise<InstallRace> {
    await executable(
      join(this.root, 'platform-bin', 'mkdir'),
      lockAttemptRendezvous(
        quote(this.channelRoot(release.channel)),
        quote(this.control('together')),
      ),
    );
    const one = this.startInstall(release).finished;
    const other = this.startInstall(release).finished;
    const first = Promise.race([
      one.then((result) => ({ result, last: other })),
      other.then((result) => ({ result, last: one })),
    ]);
    return {
      firstToFinish: first.then(({ result }) => result),
      lastToFinish: first.then(({ last }) => last),
    };
  }

  async raceTwoInstallersForTheStaleLock(): Promise<void> {
    await executable(
      join(this.root, 'platform-bin', 'cat'),
      staleLockReadBarrier(quote(this.control('stale-lock'))),
    );
  }

  async workInProjectPinning(packageManager: string): Promise<void> {
    this.workingDirectory = join(this.home, 'project');
    await mkdir(this.workingDirectory, { recursive: true });
    await writeFile(
      join(this.workingDirectory, 'package.json'),
      `${JSON.stringify({ name: 'user-project', packageManager })}\n`,
    );
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

  async skipBuildScriptsInUserPnpmSettings(source: UserPnpmSettingSource): Promise<void> {
    await this.enableUserPnpmSetting(IGNORE_SCRIPTS, source);
  }

  async enforceDependencyEnginesInUserPnpmSettings(source: UserPnpmSettingSource): Promise<void> {
    await this.enableUserPnpmSetting(ENGINE_STRICT, source);
  }

  async leaveOwnerlessLock(channel: ReleaseChannel): Promise<void> {
    await mkdir(this.channelRoot(channel), { recursive: true });
    await writeFile(this.installLock(channel), '');
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

  /** A Linux machine without libatomic, and without the host's package managers, sudo and root. */
  async lackSystemLibrary(): Promise<void> {
    await this.reportPlatform(MINIMAL_LINUX);
    await this.isolateSystemTools();
    await writeFile(this.control('library-missing'), '');
  }

  async havePackageManager(name: string, options: PackageManagerOptions = {}): Promise<void> {
    await this.isolateSystemTools();
    if (options.staleLists === true) {
      await writeFile(this.control('lists-stale'), '');
    }
    await executable(
      join(this.root, 'platform-bin', name),
      [
        `[ -z "\${FIXTURE_SUDO:-}" ] || sudo_prefix='sudo '`,
        `printf '%s\\n' "\${sudo_prefix:-}${name} $*" >> ${quote(this.control('system-commands.log'))}`,
        `if [ "\${1:-}" = update ]; then : > ${quote(this.control('lists-updated'))}; exit 0; fi`,
        ...(options.failWith === undefined
          ? []
          : [`echo ${quote(options.failWith)} >&2`, 'exit 1']),
        `if [ -e ${quote(this.control('lists-stale'))} ] && [ ! -e ${quote(this.control('lists-updated'))} ]; then`,
        ...(options.localized === true
          ? [
              '  if [ "${LC_ALL:-}" = C ] && [ "${LANG:-}" = C ]; then',
              "    echo 'E: Unable to locate package libatomic1' >&2",
              '  else',
              "    echo 'E: Paket libatomic1 kann nicht gefunden werden' >&2",
              '  fi',
            ]
          : ["  echo 'E: Unable to locate package libatomic1' >&2"]),
        '  exit 100',
        'fi',
        `[ -e ${quote(this.control('install-ineffective'))} ] || : > ${quote(this.control('library-installed'))}`,
        '',
      ].join('\n'),
    );
  }

  /** The package manager succeeds without providing the library. */
  async keepLibraryMissingAfterInstall(): Promise<void> {
    await writeFile(this.control('install-ineffective'), '');
  }

  /** The terminal closes without any input, as with Ctrl-D. */
  async closeTerminalWithoutAnswer(): Promise<void> {
    await writeFile(this.control('tty'), '');
  }

  /** ldconfig fails, so the installer looks in these directories; they hold libatomic or not. */
  async searchLibrariesOnlyIn(options: { readonly libatomic: boolean }): Promise<void> {
    const directory = this.control('libraries');
    await mkdir(directory, { recursive: true });
    if (options.libatomic) {
      await writeFile(join(directory, 'libatomic.so.1'), '');
    }
    await executable(join(this.root, 'platform-bin', 'ldconfig'), 'exit 1\n');
    this.userPnpmEnvironment.REVO_TEST_LIBRARY_DIRS = directory;
  }

  async haveSudo(): Promise<void> {
    await this.isolateSystemTools();
    await executable(join(this.root, 'platform-bin', 'sudo'), 'FIXTURE_SUDO=1 exec "$@"\n');
  }

  async runAsRoot(): Promise<void> {
    await this.isolateSystemTools();
    await writeFile(this.control('root'), '');
  }

  /** The text the user types at the terminal prompt. */
  async answerPrompt(answer: string): Promise<void> {
    await writeFile(this.control('tty'), `${answer}\n`);
  }

  allowSystemDependencyInstall(): void {
    this.userPnpmEnvironment.REVO_INSTALL_SYSTEM_DEPS = '1';
  }

  async systemCommands(): Promise<readonly string[]> {
    return lines(this.control('system-commands.log'));
  }

  /** What the installer wrote to the terminal after the answer. */
  async promptShown(): Promise<string> {
    const typed = await readFile(this.control('tty'), 'utf8').catch(() => '');
    return typed.split('\n').slice(1).join('\n');
  }

  downloads(fragment = ''): readonly string[] {
    return this.origin.requests().filter((path) => path.includes(fragment));
  }

  channelRoot(channel: ReleaseChannel): string {
    return join(this.installRoot(), channel);
  }

  installLock(channel: ReleaseChannel): string {
    return join(this.channelRoot(channel), '.lock');
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

  async existingUserDirectories(): Promise<readonly string[]> {
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const directories = CHANNELS.flatMap((channel) => {
      const layout = resolveRevoLayout({ channel, env: {}, homeDir: this.home, platform });
      return [layout.dataDir, layout.configDir, layout.stateDir, layout.cacheDir];
    });
    const existing = await Promise.all(
      directories.map(async (directory) => ((await exists(directory)) ? [directory] : [])),
    );
    return existing.flat();
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
      ...(this.options.binDirOnPath === true ? [join(this.home, '.local', 'bin')] : []),
      this.systemPath,
    ];
    const environment: NodeJS.ProcessEnv = {
      ...this.userPnpmEnvironment,
      CURL_CA_BUNDLE: this.certificate.certPath,
      HOME: this.home,
      LC_ALL: 'C',
      PATH: path.join(':'),
      REVO_TEST_TTY: this.control('tty'),
    };
    if (this.options.installRoot !== undefined) {
      environment.REVO_INSTALL_ROOT = this.installRoot();
    }
    return environment;
  }

  private async enableUserPnpmSetting(
    setting: FixturePnpmSetting,
    source: UserPnpmSettingSource,
  ): Promise<void> {
    if (source === 'environment') {
      this.userPnpmEnvironment[setting.environment] = 'true';
      return;
    }
    await Promise.all(
      USER_PNPM_CONFIG_DIRS.map(async (directory) => {
        await mkdir(join(this.home, directory), { recursive: true });
        await appendFile(join(this.home, directory, 'config.yaml'), `${setting.configKey}: true\n`);
      }),
    );
  }

  private installRoot(): string {
    if (this.options.installRoot === undefined) {
      return join(this.home, '.local', 'share', 'revo-install');
    }
    return join(this.root, this.options.installRoot);
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

  // ldconfig lists libatomic unless the scenario removed it and no package manager has added it back.
  private async installLibraryCache(): Promise<void> {
    await executable(
      join(this.root, 'platform-bin', 'ldconfig'),
      [
        `if [ -e ${quote(this.control('library-missing'))} ] && [ ! -e ${quote(this.control('library-installed'))} ]; then`,
        "  printf '1 libs found in cache\\n\\tlibc.so.6 (libc6,x86-64) => /lib/x86_64-linux-gnu/libc.so.6\\n'",
        '  exit 0',
        'fi',
        "printf '2 libs found in cache\\n\\tlibatomic.so.1 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libatomic.so.1\\n'",
        '',
      ].join('\n'),
    );
  }

  // The installer finds tools through PATH, so a scenario that must not see the host's package
  // managers or sudo gets a PATH of every other system tool.
  private async isolateSystemTools(): Promise<void> {
    if (this.systemPath !== SYSTEM_PATH) {
      return;
    }
    const systemBin = join(this.root, 'system-bin');
    await mkdir(systemBin);
    const listings = await Promise.all(
      SYSTEM_BIN_DIRECTORIES.map((directory) => readdir(directory).catch(() => [])),
    );
    const names = new Set(listings.flat());
    await Promise.all(
      [...names]
        .filter((name) => !SYSTEM_DEPENDENCY_TOOLS.includes(name))
        .map(async (name) => {
          const directory = SYSTEM_BIN_DIRECTORIES.find((candidate) =>
            existsSync(join(candidate, name)),
          );
          await symlink(join(directory ?? '/usr/bin', name), join(systemBin, name)).catch(
            () => undefined,
          );
        }),
    );
    await executable(
      join(this.root, 'platform-bin', 'id'),
      `if [ -e ${quote(this.control('root'))} ]; then echo 0; else echo 1000; fi\n`,
    );
    this.systemPath = systemBin;
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
      [`${top}/bin/node`]:
        this.options.brokenToolchain === 'node'
          ? loaderFailure('node')
          : `exec ${quote(process.execPath)} "$@"\n`,
    });
  }

  private async pnpmArchive(): Promise<Buffer> {
    return this.archive('pnpm', '.', {
      pnpm: [
        ...(this.options.brokenToolchain === 'pnpm' ? [loaderFailure('pnpm')] : []),
        `if grep -q '"packageManager"' package.json 2>/dev/null && ! grep -q '"pnpm@${PNPM_VERSION}"' package.json; then`,
        "  echo 'ERR_PNPM_OTHER_PM_EXPECTED: this project is configured to use another package manager' >&2",
        '  exit 1',
        'fi',
        `if [ "\${1:-}" = --version ]; then echo ${PNPM_VERSION}; exit 0; fi`,
        `printf '%s|%s\\n' "$(command -v node)" "$*" >> ${quote(this.control('pnpm-installs.log'))}`,
        '[ -f package.json ] && [ -f pnpm-lock.yaml ] && [ -f pnpm-workspace.yaml ] || exit 3',
        ...fixturePnpmSetting(IGNORE_SCRIPTS),
        ...fixturePnpmSetting(ENGINE_STRICT),
        'if [ "$engine_strict" = true ]; then',
        "  echo 'ERR_PNPM_UNSUPPORTED_ENGINE: a release dependency declares an engine range the private Node.js does not satisfy' >&2",
        '  exit 1',
        'fi',
        `if mv ${quote(this.control('pnpm-gate'))} ${quote(this.control('pnpm-held'))} 2>/dev/null; then`,
        `  : > ${quote(this.control('pnpm-started'))}`,
        `  { read -r _ < ${quote(this.control('pnpm-held'))}; } 2>/dev/null`,
        'fi',
        'mkdir -p node_modules && : > node_modules/.fixture-installed',
        '[ "$ignore_scripts" = true ] || : > node_modules/.fixture-built',
        '',
      ].join('\n'),
    });
  }

  private async revoPackage(version: string): Promise<Buffer> {
    return this.archive(`revo-${version}`, 'package', {
      'package/package.json': `${JSON.stringify({ name: '@revisium/revo', version, type: 'module' })}\n`,
      'package/dist/bin/revo.js': [
        "import { appendFileSync, existsSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(this.control('revo-invocations.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "if (!existsSync(new URL('../../node_modules/.fixture-built', import.meta.url))) {",
        "  console.error('dependencies were installed without their build scripts');",
        '  process.exit(1);',
        '}',
        `if (process.argv[2] === '--version') console.log(${JSON.stringify(version)});`,
        "if (process.argv[2] === '--launcher-channel') console.log(process.env.REVO_LAUNCHER_CHANNEL);",
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

function loaderFailure(tool: string): string {
  return `echo "./${tool}: ${LIBRARY_LOADER_ERROR}" >&2\nexit 127\n`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}`);
  await chmod(path, 0o755);
}

// The fixture pnpm reads a boolean setting like pnpm: the command line wins over the environment,
// which wins over the user's configuration file.
function fixturePnpmSetting(setting: FixturePnpmSetting): readonly string[] {
  const { variable } = setting;
  return [
    `${variable}=false`,
    ...USER_PNPM_CONFIG_DIRS.map(
      (directory) =>
        `! grep -qx '${setting.configKey}: true' "$HOME"/${quote(directory)}/config.yaml 2>/dev/null || ${variable}=true`,
    ),
    `${variable}=\${${setting.environment}:-$${variable}}`,
    `for arg; do case "$arg" in --config.${setting.flag}=*) ${variable}=\${arg#*=} ;; esac; done`,
  ];
}

// Barrier markers are claimed with an exclusive create: mkdir is not exclusive in every coreutils.
const CLAIM_MARKER = ['claim() {', '  (set -C; : >"$1") 2>/dev/null', '}'];

// Both installers wait just before taking the lock, so they try to take it at the same moment.
function lockAttemptRendezvous(channelRoot: string, barrier: string): string {
  return [
    `[ "$#" -eq 2 ] && [ "$1" = -p ] && [ "$2" = ${channelRoot} ] || exec /bin/mkdir "$@"`,
    '/bin/mkdir "$@" || exit',
    ...CLAIM_MARKER,
    `claim ${barrier}-1 || claim ${barrier}-2`,
    'tries=0',
    `until [ -e ${barrier}-1 ] && [ -e ${barrier}-2 ]; do`,
    '  tries=$((tries + 1))',
    '  [ "$tries" -lt 500000 ] || break',
    'done',
    '',
  ].join('\n');
}

// The second installer reads the stale owner before the first takes the lock over, and acts after.
function staleLockReadBarrier(barrier: string): string {
  return [
    'case "${1:-}" in */.lock) ;; *) exec /bin/cat "$@" ;; esac',
    ...CLAIM_MARKER,
    'wait_for() {',
    '  tries=0',
    '  until "$@"; do',
    '    tries=$((tries + 1))',
    '    [ "$tries" -lt 3000 ] || return 0',
    '    sleep 0.01',
    '  done',
    '}',
    'taken_over() {',
    '  current=$(/bin/cat "$1" 2>/dev/null) && [ -n "$current" ] && [ "$current" != "$stale" ] &&',
    '    [ ! -e "$1.takeover" ]',
    '}',
    `if claim ${barrier}-first; then`,
    `  wait_for test -e ${barrier}-second-read`,
    '  exec /bin/cat "$1"',
    'fi',
    `if claim ${barrier}-second; then`,
    '  stale=$(/bin/cat "$1") || exit 1',
    `  : >${barrier}-second-read`,
    '  wait_for taken_over "$1"',
    `  printf '%s\\n' "$stale"`,
    '  exit 0',
    'fi',
    'exec /bin/cat "$1"',
    '',
  ].join('\n');
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
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
