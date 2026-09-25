import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { vi } from 'vitest';

import { bootstrapPolicy } from './installer-builder-scenario.js';
import {
  futureReleaseManifestFixture,
  futureReleasePolicyFixture,
  type NodeArchiveArchitecture,
  type NodeArchiveFormat,
  type NodeArchivePlatform,
} from './release-manifest-fixture.js';

const SUPPORT = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(dirname(SUPPORT)));
const BUILDER = new URL('../../../installer/build-installer.mjs', import.meta.url).href;
const PAYLOAD = join(ROOT, 'installer', 'node-bootstrap.mjs');
const DIVERGENT_ARCHIVE_SHA256 = createHash('sha256').update('divergent archive').digest('hex');
const HOST_SHA256SUM = '/usr/bin/sha256sum';
const HOST_TAR = '/bin/tar';

// A sentinel any shell expansion of the fixture's hostile names would create in the spawned
// installer's working directory, which is this fixture root.
const SENTINEL = 'hostile-sentinel';

// State the installer must never read, write, or expand: the directory handed to it as TMPDIR, and
// an unrelated neighbour. Both names carry whitespace, shell punctuation, and a sentinel command
// substitution, so any unquoted use of them is observable rather than silent.
const OUTSIDE_STATE = [
  {
    directory: `hostile tmp; $(touch ${SENTINEL}) 'quoted' \`touch ${SENTINEL}\``,
    file: `marker; $(touch ${SENTINEL}).txt`,
    bytes: 'hostile tmpdir marker',
  },
  {
    directory: 'unrelated',
    file: `kept note; $(touch ${SENTINEL}) 'quoted'.txt`,
    bytes: 'unrelated state',
  },
] as const;

// install.sh.in shells out to these by bare name (mkdir, mktemp, cat, ls, cut, awk, rm, mv, sleep,
// chmod, rmdir), and the fixture's own downloader wrappers shell out to bare cp; every other external
// command run (uname/curl/wget/sha256sum/tar/node) is one of the fixture's own instrumented
// wrappers below. gzip and xz are tar transitive compressor helpers. The spawned installer's
// PATH is tools-only, so each entry here must be resolved from the host and linked in, or the
// script fails with "not found".
const HOST_TOOL_ALLOWLIST = [
  'mkdir',
  'mktemp',
  'chmod',
  'cat',
  'ls',
  'cut',
  'awk',
  'rm',
  'mv',
  'sleep',
  'cp',
  'gzip',
  'xz',
  'setsid',
  'rmdir',
] as const;

interface InstallerBuilder {
  readonly buildInstaller: (input: unknown) => string;
}

export interface PosixTarget {
  readonly system: string;
  readonly machine: string;
  readonly platform: Extract<NodeArchivePlatform, 'darwin' | 'linux'>;
  readonly arch: NodeArchiveArchitecture;
  readonly format: Extract<NodeArchiveFormat, 'tar.gz' | 'tar.xz'>;
}
type HoldStage = 'download' | 'probe' | 'payload';
export type ExistingInstallLock = 'empty-dir' | 'stale-dir' | 'foreign-marker' | 'file' | 'symlink';

// Each injected failure lets the installer's real step succeed first and only then reports a
// nonzero status, so the installer observes a genuine late failure of a completed operation.
export type InjectedFailure =
  | 'download-after-copy'
  | 'sha256-after-output'
  | 'shasum-after-output'
  | 'tar-after-extract'
  | 'payload-after-receipt';

interface RunOptions extends PosixTarget {
  readonly downloader?: 'curl' | 'wget';
  readonly payload?: 'ready' | 'held' | 'hostile';
  readonly publishedSha256?: 'authentic' | 'divergent';
  readonly failure?: InjectedFailure;
  readonly watchdog?: 'download-hang';
  readonly hold?: HoldStage;
  readonly resistant?: boolean;
}

type PayloadProgram = 'ready' | 'held' | 'receipt-then-fail' | 'resistant';

interface SnapshotEntry {
  readonly path: string;
  readonly kind: 'directory' | 'file' | 'symlink';
  readonly mode: number;
  readonly bytes?: string;
  readonly link?: string;
}

interface Observation {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly downloadArgv: readonly string[];
  readonly events: readonly string[];
  readonly probeArgv: readonly string[];
  readonly payloadArgv: readonly string[];
  readonly dataPath: string;
  readonly payloadPath: string;
  readonly receipt: unknown;
  readonly receiptMode: number | undefined;
  readonly finalLayout: readonly string[];
  readonly hostileSentinel: boolean;
  readonly targetSnapshot: readonly SnapshotEntry[];
  readonly ownedResidue: readonly string[];
  readonly watchdogTermGrace: boolean;
}

interface RunningInstaller {
  readonly finish: Promise<Observation>;
  signal(signal?: NodeJS.Signals): void;
}

interface InvocationPaths {
  readonly stageGate: string;
  readonly downloadArgv: string;
  readonly events: string;
  readonly payloadArgv: string;
  readonly probeArgv: string;
  readonly heldChildPid: string;
  readonly watchdogPid: string;
  readonly watchdogBounds: string;
  readonly stageIdentity: string;
  readonly watchdogIdentity: string;
}

interface OwnedChild {
  completion: Promise<void>;
  readonly processGroupId: number | undefined;
  parentTerminal: boolean;
}

export class InstallerPosixBootstrapScenario {
  private readonly children = new Map<ChildProcess, OwnedChild>();
  private cleanupUnsafe = false;
  private invocation = '';
  private invocationNumber = 0;
  private stageGate = '';
  private servedChunks: Buffer[] = [];

  private constructor(private readonly root: string) {}

  static async create(): Promise<InstallerPosixBootstrapScenario> {
    return new InstallerPosixBootstrapScenario(await mkdtemp(join(tmpdir(), 'revo-b2a-')));
  }

  async run(options: RunOptions): Promise<Observation> {
    return (await this.start(options)).finish;
  }

  async start(options: RunOptions): Promise<RunningInstaller> {
    this.beginInvocation();
    await this.prepare(options);
    const paths = this.invocationPaths();
    const child = spawn('/bin/sh', [this.path('install.sh')], {
      cwd: this.root,
      env: this.environment(options, paths, this.invocation),
      detached: true,
      stdio: 'ignore',
    });
    const owned = trackOwnedChild(child);
    this.children.set(child, owned);
    return {
      finish: this.observe(child, options, owned.completion, paths),
      signal: (signal = 'SIGTERM') => child.kill(signal),
    };
  }

  async startContender(options: RunOptions): Promise<RunningInstaller> {
    const invocation = `${process.pid}-${Date.now()}-${++this.invocationNumber}`;
    const scope = `contender-${this.invocationNumber}`;
    await mkdir(this.path(scope), { recursive: true });
    const paths = this.invocationPaths(scope);
    const child = spawn('/bin/sh', [this.path('install.sh')], {
      cwd: this.root,
      env: this.environment(options, paths, invocation),
      detached: true,
      stdio: 'ignore',
    });
    const owned = trackOwnedChild(child);
    this.children.set(child, owned);
    return {
      finish: this.observe(child, options, owned.completion, paths),
      signal: (signal = 'SIGTERM') => child.kill(signal),
    };
  }

  async startFromStdin(options: RunOptions): Promise<RunningInstaller> {
    this.beginInvocation();
    await this.prepare(options);
    const paths = this.invocationPaths();
    const child = spawn('/bin/sh', [], {
      cwd: this.root,
      env: this.environment(options, paths, this.invocation),
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin?.end(await readFile(this.path('install.sh')));
    const owned = trackOwnedChild(child);
    this.children.set(child, owned);
    return {
      finish: this.observe(child, options, owned.completion, paths),
      signal: (signal = 'SIGTERM') => child.kill(signal),
    };
  }

  async startOverHttp(options: RunOptions): Promise<RunningInstaller> {
    this.beginInvocation();
    await this.prepare(options);
    const script = await readFile(this.path('install.sh'));
    this.servedChunks = chunkScript(script);
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      for (const chunk of this.servedChunks) {
        response.write(chunk);
      }
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('fixture server missing port');
    }
    const paths = this.invocationPaths();
    const url = `http://127.0.0.1:${address.port}/install.sh`;
    const child = spawn(
      '/bin/sh',
      ['-c', `/usr/bin/curl --fail --silent --show-error '${url}' | /bin/sh`],
      {
        cwd: this.root,
        env: { ...this.environment(options, paths, this.invocation), NO_PROXY: '127.0.0.1' },
        detached: true,
        stdio: 'ignore',
      },
    );
    const owned = trackOwnedChild(child);
    this.children.set(child, owned);
    const finish = (async () => {
      const result = await this.observe(child, options, owned.completion, paths);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return result;
    })();
    return { finish, signal: (signal = 'SIGTERM') => child.kill(signal) };
  }

  servedScript(): string {
    return Buffer.concat(this.servedChunks).toString('utf8');
  }

  async generatedScript(): Promise<string> {
    return readFile(this.path('install.sh'), 'utf8');
  }

  servedScriptChunks(): readonly string[] {
    return this.servedChunks.map((chunk) => chunk.toString('utf8'));
  }

  invocationId(): string {
    return this.invocation;
  }

  async stageIdentity(
    stage: HoldStage,
  ): Promise<{ readonly invocation: string; readonly pid: number }> {
    const [observedStage, invocation, rawPid] = (
      await readFile(this.path('stage.identity'), 'utf8')
    )
      .trim()
      .split('\n');
    const pid = Number(rawPid);
    if (
      observedStage !== stage ||
      invocation !== this.invocation ||
      !Number.isSafeInteger(pid) ||
      pid <= 0
    ) {
      throw new Error(`fixture did not record the current ${stage} identity`);
    }
    return { invocation, pid };
  }

  async watchdogIdentity(): Promise<{ readonly invocation: string; readonly pid: number }> {
    const [invocation, rawPid] = (await readFile(this.path('watchdog.identity'), 'utf8'))
      .trim()
      .split('\n');
    const pid = Number(rawPid);
    if (invocation !== this.invocation || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error('fixture did not record the current watchdog identity');
    }
    return { invocation, pid };
  }

  expectedDownloadArgv(tool: 'curl' | 'wget', stage: string): readonly string[] {
    const output = join(stage, 'node-archive');
    return tool === 'curl'
      ? ['curl', '--fail', '--silent', '--show-error', '--output', output, this.archiveUrl]
      : ['wget', '--max-redirect=0', '-q', '-O', output, this.archiveUrl];
  }

  expectedReceipt(target: PosixTarget) {
    return {
      version: '26.8.2',
      target: `${target.platform}-${target.arch}`,
      archiveSha256: this.sha,
    };
  }

  finalNode(target: PosixTarget): string {
    return join(this.finalPath(target), 'bin', 'node');
  }

  async waitFor(marker: string, timeoutMs = 2_000): Promise<void> {
    await waitForEvent(() => this.events(), marker, timeoutMs);
  }

  async releasePayload(): Promise<void> {
    await Promise.all([writeFile(this.path('payload-gate'), 'release'), this.releaseStage()]);
  }

  async releaseStage(): Promise<void> {
    await writeFile(this.stageGate, 'release');
  }

  async heldChildPid(): Promise<number> {
    return this.recordedPid('held-child.pid');
  }

  async watchdogPid(): Promise<number> {
    return this.recordedPid('watchdog.pid');
  }

  async waitForProcessExit(pid: number): Promise<boolean> {
    return pollProcessExit(pid, 200);
  }

  // Observes already completed runs, so it only reads process existence and never signals a PID
  // this fixture no longer owns.
  async processesAbsent(pids: readonly number[]): Promise<boolean> {
    const observed = await Promise.all(pids.map(async (pid) => pollProcessAbsent(pid, 50)));
    return observed.every((absent) => absent);
  }

  async receipt(): Promise<unknown> {
    return jsonOrMissing(this.path('state', '26.8.2', 'linux-x64', 'install-receipt.json'));
  }

  async stageSnapshot(): Promise<readonly SnapshotEntry[]> {
    return (await snapshot(this.path('state'))).filter((entry) => entry.path.includes('.stage.'));
  }

  async finalSnapshot(): Promise<readonly SnapshotEntry[]> {
    return snapshot(this.path('state', '26.8.2', 'linux-x64'));
  }

  async stageRoots(): Promise<readonly string[]> {
    return (await this.stageSnapshot())
      .map((entry) => entry.path)
      .filter((path) => !path.slice('26.8.2/'.length).includes('/'));
  }

  async stateOutsideStage(): Promise<readonly string[]> {
    return (await snapshot(this.path('state')))
      .map((entry) => entry.path)
      .filter(
        (path) =>
          path !== '.' &&
          path !== '26.8.2' &&
          !path.includes('.stage.') &&
          !path.includes('.install.lock'),
      );
  }

  async outsideSnapshot(): Promise<readonly SnapshotEntry[]> {
    const roots = await Promise.all(
      OUTSIDE_STATE.map(async ({ directory }) => snapshot(this.path(directory))),
    );
    return roots.flat();
  }

  expectedOutsideSnapshot(): readonly SnapshotEntry[] {
    return OUTSIDE_STATE.flatMap(({ file, bytes }) => [
      { path: '.', kind: 'directory' as const, mode: 0o700 },
      { path: file, kind: 'file' as const, mode: 0o600, bytes },
    ]);
  }

  async seedValidTarget(target: PosixTarget, hold?: HoldStage): Promise<void> {
    this.beginInvocation();
    await this.prepare({
      ...target,
      payload: 'ready',
      ...(hold === undefined ? {} : { hold }),
    });
    await this.seedDirectory(target, JSON.stringify(this.expectedReceipt(target)), 0o600);
  }

  async seedExisting(kind: 'invalid-receipt' | 'symlink', target: PosixTarget): Promise<void> {
    this.beginInvocation();
    await this.prepare({ ...target, payload: 'ready' });
    if (kind === 'invalid-receipt') {
      await this.seedDirectory(target, '{"untrusted":true}', 0o666);
      return;
    }
    await mkdir(this.path('outside'), { recursive: true });
    await writeFile(this.path('outside', 'preserved'), 'outside');
    await mkdir(dirname(this.finalPath(target)), { recursive: true });
    await symlink(this.path('outside'), this.finalPath(target));
  }

  async seedLock(kind: ExistingInstallLock, target: PosixTarget): Promise<void> {
    this.beginInvocation();
    await this.prepare({ ...target, payload: 'ready' });
    const lock = this.lockPath(target);
    await mkdir(dirname(lock), { recursive: true });
    if (kind === 'file') {
      await writeFile(lock, 'foreign lock');
    } else if (kind === 'symlink') {
      await mkdir(this.path('foreign-lock'), { recursive: true });
      await writeFile(this.path('foreign-lock', 'preserved'), 'foreign');
      await symlink(this.path('foreign-lock'), lock);
    } else {
      await mkdir(lock);
      if (kind === 'stale-dir') {
        await writeFile(join(lock, '.owner.stale'), 'stale');
      }
      if (kind === 'foreign-marker') {
        await writeFile(join(lock, '.owner.foreign'), 'foreign');
      }
    }
  }

  async lockSnapshot(target: PosixTarget): Promise<readonly SnapshotEntry[]> {
    return snapshot(this.lockPath(target));
  }

  async replaceLockMarker(target: PosixTarget): Promise<void> {
    const lock = this.lockPath(target);
    const marker = (await readdir(lock)).find((name) => name.startsWith('.owner.'));
    if (marker === undefined) {
      throw new Error('fixture lock marker missing');
    }
    await rm(join(lock, marker));
    await writeFile(join(lock, marker), 'foreign replacement');
  }

  async deleteLockMarker(target: PosixTarget): Promise<void> {
    const lock = this.lockPath(target);
    const marker = (await readdir(lock)).find((name) => name.startsWith('.owner.'));
    if (marker === undefined) {
      throw new Error('fixture lock marker missing');
    }
    await rm(join(lock, marker));
  }

  async existingSnapshot(): Promise<readonly SnapshotEntry[]> {
    return [...(await snapshot(this.path('state'))), ...(await snapshot(this.path('outside')))];
  }

  async cleanup(): Promise<void> {
    const confirmations = await Promise.all(
      [...this.children.values()].map(async (owned) => {
        const { completion, processGroupId } = owned;
        if (processGroupId === undefined) {
          return false;
        }
        if (!owned.parentTerminal) {
          killOwnedProcessGroup(processGroupId);
        }
        const [parentExited, groupExited] = await Promise.all([
          boundedConfirmation(completion),
          boundedGroupExit(processGroupId),
        ]);
        return parentExited && groupExited;
      }),
    );
    if (confirmations.some((confirmed) => !confirmed)) {
      throw new Error(`preserved live-writer fixture root: ${this.root}`);
    }
    if (this.cleanupUnsafe) {
      throw new Error(`preserved unconfirmed archive fixture root: ${this.root}`);
    }
    await rm(this.root, { recursive: true, force: true });
    this.children.clear();
  }

  private archiveUrl = '';
  private preparedTarget = '';
  private sha = '';

  private beginInvocation(): void {
    this.invocation = `${process.pid}-${Date.now()}-${++this.invocationNumber}`;
    this.stageGate = this.path(`stage-gate-${this.invocation}`);
  }

  private invocationPaths(scope = ''): InvocationPaths {
    const path = (name: string): string =>
      scope === '' ? this.path(name) : this.path(scope, name);
    return {
      stageGate: path(`stage-gate-${this.invocation}`),
      downloadArgv: path('download.argv'),
      events: path('events'),
      payloadArgv: path('payload.argv'),
      probeArgv: path('probe.argv'),
      heldChildPid: path('held-child.pid'),
      watchdogPid: path('watchdog.pid'),
      watchdogBounds: path('watchdog.bounds'),
      stageIdentity: path('stage.identity'),
      watchdogIdentity: path('watchdog.identity'),
    };
  }

  private environment(
    options: RunOptions,
    paths: InvocationPaths,
    invocation: string,
  ): NodeJS.ProcessEnv {
    return {
      PATH: this.path('tools'),
      TMPDIR: this.path(OUTSIDE_STATE[0].directory),
      REVO_INSTALL_ROOT: this.path('state'),
      REVO_PAYLOAD_GATE: this.path('payload-gate'),
      REVO_TEST_ARCHIVE: this.path('archive'),
      REVO_TEST_ARGV: paths.downloadArgv,
      REVO_TEST_EVENTS: paths.events,
      REVO_TEST_NODE_PAYLOAD_ARGV: paths.payloadArgv,
      REVO_TEST_NODE_PROBE_ARGV: paths.probeArgv,
      REVO_TEST_HELD_CHILD_PID: paths.heldChildPid,
      REVO_TEST_WATCHDOG_PID: paths.watchdogPid,
      REVO_TEST_WATCHDOG_BOUNDS: paths.watchdogBounds,
      REVO_TEST_INVOCATION: invocation,
      REVO_TEST_STAGE_GATE: paths.stageGate,
      REVO_TEST_STAGE_IDENTITY: paths.stageIdentity,
      REVO_TEST_WATCHDOG_IDENTITY: paths.watchdogIdentity,
      REVO_TEST_WATCHDOG_ACTIVE: options.hold === undefined ? '' : '1',
      REVO_TEST_WATCHDOG_LIMIT: watchdogLimit(options),
    };
  }

  private async prepare(options: RunOptions): Promise<void> {
    if (this.invocation === '') {
      this.beginInvocation();
    }
    await mkdir(this.path('tools'), { recursive: true });
    await this.seedOutsideState();
    await this.prepareArchive(options, payloadProgram(options));
    await this.writeTools(options);
    await this.writeInstaller(options);
  }

  private async seedOutsideState(): Promise<void> {
    await Promise.all(
      OUTSIDE_STATE.map(async ({ directory, file, bytes }) => {
        await mkdir(this.path(directory), { recursive: true });
        await chmod(this.path(directory), 0o700);
        await writeFile(this.path(directory, file), bytes, { mode: 0o600 });
        await chmod(this.path(directory, file), 0o600);
      }),
    );
  }

  private async prepareArchive(options: RunOptions, payload: PayloadProgram): Promise<void> {
    const target = `${options.platform}-${options.arch}`;
    if (this.preparedTarget === target) {
      return;
    }
    if (this.preparedTarget !== '') {
      throw new Error('fixture cannot prepare two Node targets in one scenario');
    }
    await mkdir(this.path('archive-root'), { recursive: true });
    const archiveRoot = this.path('archive-root', `node-v26.8.2-${target}`);
    await mkdir(join(archiveRoot, 'bin'), { recursive: true });
    await executable(
      join(archiveRoot, 'bin', 'node'),
      this.nodeProgram(payload, options.hold, options.resistant === true),
    );
    await writeFile(join(archiveRoot, 'LAYOUT'), 'canonical archive layout');
    this.cleanupUnsafe = true;
    await createTar(this.path('archive'), archiveRoot, options.format, () => {
      this.cleanupUnsafe = false;
    });
    this.sha = createHash('sha256')
      .update(await readFile(this.path('archive')))
      .digest('hex');
    this.archiveUrl = `https://downloads.example/node-'quoted-${target}.${options.format}`;
    this.preparedTarget = target;
  }

  private async writeInstaller(options: RunOptions): Promise<void> {
    const base = futureReleasePolicyFixture({ supportedSchemaVersions: ['revo-install/v2'] });
    const policy = {
      ...base,
      locators: {
        ...base.locators,
        nodeArchive: (
          version: string,
          platform: NodeArchivePlatform,
          arch: NodeArchiveArchitecture,
          format: NodeArchiveFormat,
        ) =>
          platform === options.platform && arch === options.arch && format === options.format
            ? this.archiveUrl
            : base.locators.nodeArchive(version, platform, arch, format),
      },
    };
    const fixture = futureReleaseManifestFixture({ policy });
    const published = options.publishedSha256 === 'divergent' ? DIVERGENT_ARCHIVE_SHA256 : this.sha;
    const manifest = {
      ...fixture.manifest,
      toolchain: {
        ...fixture.manifest.toolchain,
        nodeArchives: fixture.manifest.toolchain.nodeArchives.map((archive) =>
          archive.platform === options.platform && archive.arch === options.arch
            ? { ...archive, sha256: published }
            : archive,
        ),
      },
    };
    const bounded =
      options.watchdog === 'download-hang'
        ? { ...bootstrapPolicy, downloadTimeoutSeconds: 1, terminationGraceSeconds: 1 }
        : options.hold === undefined
          ? bootstrapPolicy
          : { ...bootstrapPolicy, terminationGraceSeconds: 1 };
    const { buildInstaller } = await vi.importActual<InstallerBuilder>(BUILDER);
    const { buildPayload } = await vi.importActual<{
      buildPayload: (input: { readonly entry: string }) => Promise<string>;
    }>(new URL('../../../installer/build-payload.mjs', import.meta.url).href);
    const template = await readFile(join(ROOT, 'installer', 'install.sh.in'), 'utf8');
    const payloadSource = await buildPayload({ entry: PAYLOAD });
    const payload =
      options.payload === 'hostile'
        ? `${payloadSource}\n// '; touch ${this.path(SENTINEL)} #\n`
        : payloadSource;
    await writeFile(
      this.path('install.sh'),
      buildInstaller({ manifest, policy, bootstrapPolicy: bounded, template, payload }),
      { mode: 0o700 },
    );
  }

  private async writeTools(options: RunOptions): Promise<void> {
    await executable(
      this.path('tools', 'uname'),
      `#!/bin/sh\n[ "$1" = -s ] && printf '%s\\n' '${options.system}' || printf '%s\\n' '${options.machine}'\n`,
    );
    await executable(this.path('tools', 'curl'), downloaderProgram('curl', options));
    if (options.downloader === 'wget') {
      await rm(this.path('tools', 'curl'));
    }
    await executable(this.path('tools', 'wget'), downloaderProgram('wget', options));
    await this.writeHasher(options);
    await executable(
      this.path('tools', 'tar'),
      options.failure === 'tar-after-extract'
        ? failingWrapper(`tar:${options.format}`, HOST_TAR, '"$@"')
        : wrapper(`tar:${options.format}`, HOST_TAR),
    );
    await executable(this.path('tools', 'node'), '#!/bin/sh\nexit 97\n');
    await Promise.all(
      HOST_TOOL_ALLOWLIST.map(async (name) =>
        ensureHostToolLink(this.path('tools', name), await resolveHostTool(name)),
      ),
    );
    await this.writeBoundedSleep(options);
  }

  private async writeHasher(options: RunOptions): Promise<void> {
    if (options.failure === 'shasum-after-output') {
      await rm(this.path('tools', 'sha256sum'), { force: true });
      await executable(
        this.path('tools', 'shasum'),
        failingWrapper(
          'shasum',
          HOST_SHA256SUM,
          '"$3"',
          '[ "$1" = -a ] && [ "$2" = 256 ] || exit 89\n',
        ),
      );
      return;
    }
    await executable(
      this.path('tools', 'sha256sum'),
      options.failure === 'sha256-after-output'
        ? failingWrapper('sha256', HOST_SHA256SUM, '"$@"')
        : wrapper('sha256', HOST_SHA256SUM),
    );
  }

  // The allowlist already linked sleep to the host binary, so the host binary is resolved first and
  // the symlink is unlinked before the wrapper is written: writing through it would replace the
  // host utility itself.
  private async writeBoundedSleep(options: RunOptions): Promise<void> {
    if (options.watchdog !== 'download-hang' && options.hold === undefined) {
      return;
    }
    const host = await resolveHostTool('sleep');
    await rm(this.path('tools', 'sleep'), { force: true });
    await executable(this.path('tools', 'sleep'), boundedSleepProgram(host, options));
  }

  private async recordedPid(name: string): Promise<number> {
    const value = Number(await readFile(this.path(name), 'utf8'));
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`fixture did not record a valid PID: ${name}`);
    }
    return value;
  }

  private nodeProgram(payload: PayloadProgram, hold?: HoldStage, resistant = false): string {
    return `#!/bin/sh
if [ "$1" = --version ]; then
  printf '%s\\0' "$0" "$@" >"$REVO_TEST_NODE_PROBE_ARGV"
  if IFS= read -r ignored; then exit 91; fi
${hold === 'probe' ? heldStageProgram('probe') : ''}
  printf 'probe-stdin-eof\\nprobe\\n' >>"$REVO_TEST_EVENTS"
  printf 'v26.8.2\\n'
  exit 0
fi
printf '%s\\0' "$0" "$@" >"$REVO_TEST_NODE_PAYLOAD_ARGV"
if IFS= read -r ignored; then exit 92; fi
printf 'payload-stdin-eof\\n' >>"$REVO_TEST_EVENTS"
${hold === 'payload' ? heldStageProgram('payload', resistant) : payload === 'held' ? `printf '%s' "$$" >"$REVO_TEST_HELD_CHILD_PID"\nprintf 'payload-held\\n' >>"$REVO_TEST_EVENTS"\nwhile [ ! -f "$REVO_PAYLOAD_GATE" ]; do sleep 0.02; done` : ''}
printf 'payload\\n' >>"$REVO_TEST_EVENTS"
${
  payload === 'receipt-then-fail'
    ? `"${process.execPath}" "$@" || exit 93\n[ -f "$REVO_RECEIPT_PATH" ] || exit 94\nexit 1`
    : `exec "${process.execPath}" "$@"`
}
`;
  }

  private async seedDirectory(target: PosixTarget, receipt: string, mode: number): Promise<void> {
    const final = this.finalPath(target);
    await mkdir(join(final, 'bin'), { recursive: true });
    await copyFile(
      this.path('archive-root', `node-v26.8.2-${target.platform}-${target.arch}`, 'bin', 'node'),
      join(final, 'bin', 'node'),
    );
    await chmod(join(final, 'bin', 'node'), 0o700);
    await writeFile(join(final, 'LAYOUT'), 'preserved');
    await writeFile(join(final, 'install-receipt.json'), receipt, { mode });
    await chmod(join(final, 'install-receipt.json'), mode);
  }

  private finalPath(target: PosixTarget): string {
    return this.path('state', '26.8.2', `${target.platform}-${target.arch}`);
  }

  private lockPath(target: PosixTarget): string {
    return join(dirname(this.finalPath(target)), `.${target.platform}-${target.arch}.install.lock`);
  }

  private async observe(
    child: ChildProcess,
    target: PosixTarget,
    completion: Promise<void>,
    paths: InvocationPaths = this.invocationPaths(),
  ): Promise<Observation> {
    await completion;
    const exitCode = child.exitCode;
    const signalCode = child.signalCode;
    const final = this.finalPath(target);
    const receiptPath = join(final, 'install-receipt.json');
    const receiptInfo = await lstat(receiptPath).catch(() => undefined);
    const payloadArgv = await nulArguments(paths.payloadArgv);
    return {
      exitCode,
      signalCode,
      downloadArgv: await nulArguments(paths.downloadArgv),
      events: await this.eventsAt(paths.events),
      probeArgv: await nulArguments(paths.probeArgv),
      payloadArgv,
      dataPath: payloadArgv[2] ?? '',
      payloadPath: payloadArgv[1] ?? '',
      receipt: await jsonOrMissing(receiptPath),
      receiptMode: receiptInfo?.mode === undefined ? undefined : receiptInfo.mode & 0o777,
      finalLayout: await readdir(final).then(
        (names) => names.sort(),
        () => [],
      ),
      hostileSentinel: await lstat(this.path(SENTINEL)).then(
        () => true,
        () => false,
      ),
      watchdogTermGrace: await readFile(paths.watchdogBounds, 'utf8').then(
        (value) => value.length >= 2,
        () => false,
      ),
      targetSnapshot: await snapshot(this.path('state')),
      ownedResidue: (await snapshot(this.path('state')))
        .map((entry) => entry.path)
        .filter((name) => name.includes('.stage.') || name.includes('.tmp.')),
    };
  }

  private async events(): Promise<readonly string[]> {
    return this.eventsAt(this.path('events'));
  }

  private async eventsAt(path: string): Promise<readonly string[]> {
    return readFile(path, 'utf8').then(
      (value) => value.trim().split('\n').filter(Boolean),
      () => [],
    );
  }

  private path(...parts: string[]): string {
    return join(this.root, ...parts);
  }
}

// Records its own PID before replacing itself with an unkillable-by-TERM sleep, so the installer's
// escalation has to terminate exactly that process: the wrapper never forks a descendant.
const HANGING_DOWNLOAD = `printf '%s' "$$" >"$REVO_TEST_HELD_CHILD_PID"
trap '' TERM
exec sleep 30`;

const copyingDownload = (failure: RunOptions['failure']) => `output=''
while [ "$#" -gt 0 ]; do
  case "$1" in --output|-O) shift; output=$1 ;; esac
  shift
done
cp "$REVO_TEST_ARCHIVE" "$output" || { printf 'download-unguarded\\n' >>"$REVO_TEST_EVENTS"; exit 89; }${
  failure === 'download-after-copy' ? '\nexit 1' : ''
}`;

const downloaderProgram = (name: 'curl' | 'wget', options: RunOptions) => `#!/bin/sh
printf '${name}\\0' >>"$REVO_TEST_ARGV"
printf '%s\\0' "$@" >>"$REVO_TEST_ARGV"
printf 'download\\n' >>"$REVO_TEST_EVENTS"
${
  options.watchdog === 'download-hang'
    ? HANGING_DOWNLOAD
    : `${copyingDownload(options.failure)}${options.hold === 'download' ? `\n${heldStageProgram('download')}` : ''}`
}
`;

const heldStageProgram = (
  stage: HoldStage,
  resistant = false,
) => `printf '%s\\n%s\\n%s\\n' '${stage}' "$REVO_TEST_INVOCATION" "$$" >"$REVO_TEST_STAGE_IDENTITY"
printf '${stage}-held\\n' >>"$REVO_TEST_EVENTS"
${resistant ? "trap '' INT TERM\n" : ''}while [ ! -f "$REVO_TEST_STAGE_GATE" ]; do sleep 0.02; done`;

const wrapper = (event: string, command: string) => `#!/bin/sh
printf '${event}\\n' >>"$REVO_TEST_EVENTS"
exec '${command}' "$@"
`;

// Completes the real operation before injecting the failure, and reports an unguarded event of its
// own when that real operation fails, so a broken fixture can never look like an injected one.
const failingWrapper = (event: string, command: string, argv: string, guard = '') => `#!/bin/sh
printf '${event}\\n' >>"$REVO_TEST_EVENTS"
${guard}'${command}' ${argv} || { printf '${event}-unguarded\\n' >>"$REVO_TEST_EVENTS"; exit 89; }
exit 1
`;

// Instruments only the installer's bounded waits, whose limit the watchdog run pins to one second,
// and records the watchdog process that owns them once.
const boundedSleepProgram = (command: string, options: RunOptions) => `#!/bin/sh
if [ "${options.watchdog === 'download-hang' || options.hold !== undefined ? '1' : ''}" = 1 ] && [ "$1" = "$REVO_TEST_WATCHDOG_LIMIT" ]; then
  printf 'x' >>"$REVO_TEST_WATCHDOG_BOUNDS"
  [ -s "$REVO_TEST_WATCHDOG_PID" ] || printf '%s' "$PPID" >"$REVO_TEST_WATCHDOG_PID"
  if [ "$REVO_TEST_WATCHDOG_ACTIVE" = 1 ] && [ ! -s "$REVO_TEST_WATCHDOG_IDENTITY" ]; then
    printf '%s\\n%s\\n' "$REVO_TEST_INVOCATION" "$PPID" >"$REVO_TEST_WATCHDOG_IDENTITY"
    printf 'watchdog-held\\n' >>"$REVO_TEST_EVENTS"
  fi
fi
exec '${command}' "$@"
`;

const payloadProgram = (options: RunOptions): PayloadProgram => {
  if (options.failure === 'payload-after-receipt') {
    return 'receipt-then-fail';
  }
  if (options.resistant === true) {
    return 'resistant';
  }
  return options.payload === 'held' ? 'held' : 'ready';
};

const watchdogLimit = (options: RunOptions): string =>
  options.watchdog === 'download-hang'
    ? '1'
    : options.hold === 'download'
      ? '30'
      : options.hold === 'probe'
        ? '10'
        : '120';

async function ensureHostToolLink(path: string, target: string): Promise<void> {
  const existing = await lstat(path).catch(() => undefined);
  if (existing?.isSymbolicLink() && (await readlink(path)) === target) {
    return;
  }
  if (existing !== undefined) {
    await rm(path, { force: true });
  }
  await symlink(target, path);
}

async function resolveHostTool(name: string): Promise<string> {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);

  async function resolveHostToolAt(i: number): Promise<string> {
    const dir = dirs[i];
    if (dir === undefined) {
      throw new Error(`fixture could not resolve required host utility: ${name}`);
    }
    const candidate = join(dir, name);
    const info = await stat(candidate).catch(() => undefined);
    if (info === undefined || !info.isFile()) {
      return resolveHostToolAt(i + 1);
    }
    const usable = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (usable) {
      return realpath(candidate);
    }
    return resolveHostToolAt(i + 1);
  }

  return resolveHostToolAt(0);
}

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, body, { mode: 0o700 });
  await chmod(path, 0o700);
}

function chunkScript(script: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < script.length; offset += 113) {
    chunks.push(script.subarray(offset, Math.min(offset + 113, script.length)));
  }
  return chunks;
}

async function createTar(
  path: string,
  root: string,
  format: PosixTarget['format'],
  confirmCleanup: () => void,
): Promise<void> {
  const args = format === 'tar.gz' ? ['-czf', path] : ['-cJf', path];
  const child = spawn('/bin/tar', [...args, '-C', dirname(root), basename(root)], {
    detached: true,
    stdio: 'ignore',
  });
  const processGroupId = child.pid;
  let parentTerminal = false;
  const completion = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      parentTerminal = true;
      resolve(code);
    });
  });
  const first = new Promise<{ readonly code?: number | null; readonly error?: Error }>(
    (resolve) => {
      child.once('error', (error) => resolve({ error }));
      void completion.then((code) => resolve({ code }));
    },
  );
  const observed = await boundedValue(first, 5_000);
  const primary =
    observed?.error ??
    (observed === undefined
      ? new Error('fixture tar creation timed out')
      : observed.code === 0
        ? undefined
        : new Error('fixture tar creation failed'));

  if (primary === undefined) {
    if (processGroupId === undefined || !(await boundedGroupExit(processGroupId))) {
      throw new Error('fixture tar process group exit was not confirmed');
    }
    confirmCleanup();
    return;
  }
  if (processGroupId === undefined) {
    throw primary;
  }
  if (!parentTerminal) {
    killOwnedProcessGroupWith(processGroupId, 'SIGTERM');
  }
  await boundedValue(completion, 100);
  if (!parentTerminal) {
    killOwnedProcessGroupWith(processGroupId, 'SIGKILL');
  }
  const [terminal, groupExited] = await Promise.all([
    boundedValue(completion, 1_000),
    boundedGroupExit(processGroupId),
  ]);
  if (terminal !== undefined && groupExited) {
    confirmCleanup();
  }
  throw primary;
}

function boundedValue<T>(pending: Promise<T>, milliseconds: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), milliseconds);
    void pending.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function killOwnedProcessGroupWith(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch {
    // Bounded completion and group checks below decide whether cleanup is safe.
  }
}

const jsonOrMissing = async (path: string): Promise<unknown> =>
  readFile(path, 'utf8').then(
    (value) => JSON.parse(value) as unknown,
    () => undefined,
  );

const nulArguments = async (path: string): Promise<readonly string[]> =>
  readFile(path).then(
    (value) => value.toString('utf8').split('\0').filter(Boolean),
    () => [],
  );

async function snapshot(root: string): Promise<readonly SnapshotEntry[]> {
  const visit = async (path: string, relative = '.'): Promise<SnapshotEntry[]> => {
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) {
      return [];
    }
    const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file';
    const entry: SnapshotEntry = {
      path: relative,
      kind,
      mode: info.mode & 0o777,
      ...(kind === 'file' ? { bytes: await readFile(path, 'utf8').catch(() => '<binary>') } : {}),
      ...(kind === 'symlink' ? { link: await readlink(path) } : {}),
    };
    if (kind !== 'directory') {
      return [entry];
    }
    const children = await readdir(path);
    const entries = await Promise.all(
      children.sort().map((name) => visit(join(path, name), join(relative, name))),
    );
    return [entry, ...entries.flat()];
  };
  return visit(root);
}

function trackOwnedChild(child: ChildProcess): OwnedChild {
  const owned: OwnedChild = {
    completion: Promise.resolve(),
    processGroupId: child.pid,
    parentTerminal: false,
  };
  owned.completion = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      owned.parentTerminal = true;
      reject(error);
    });
    child.once('exit', () => {
      owned.parentTerminal = true;
      resolve();
    });
  });
  return owned;
}

function killOwnedProcessGroup(processGroupId: number): void {
  try {
    process.kill(-processGroupId, 'SIGKILL');
  } catch {
    // Confirmation below distinguishes an absent group from every unsafe failure.
  }
}

async function boundedConfirmation(completion: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const confirmed = await Promise.race([
    completion.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 1_000);
    }),
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return confirmed;
}

async function boundedGroupExit(processGroupId: number): Promise<boolean> {
  return pollGroupExit(processGroupId, 100);
}

async function waitForEvent(
  readEvents: () => Promise<readonly string[]>,
  marker: string,
  remaining: number,
): Promise<void> {
  if (remaining === 0) {
    throw new Error(`fixture did not observe ${marker}`);
  }
  if ((await readEvents()).includes(marker)) {
    return;
  }
  await delay(10);
  return waitForEvent(readEvents, marker, remaining - 1);
}

async function pollGroupExit(processGroupId: number, remaining: number): Promise<boolean> {
  if (remaining === 0) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
  } catch (error) {
    return errorCode(error) === 'ESRCH';
  }
  if (!(await groupHasLiveMember(processGroupId))) {
    return true;
  }
  await delay(10);
  return pollGroupExit(processGroupId, remaining - 1);
}

// A terminated installer orphans its bounded subshell, and an orphan stays a zombie until some
// unrelated reaper collects it. Zombies keep answering the group signal probe yet cannot write,
// so only a live member may hold up fixture cleanup. Every PID the scan cannot positively rule
// out counts as live, so an unreadable directory or entry never licenses deleting the root.
async function groupHasLiveMember(processGroupId: number): Promise<boolean> {
  const pids = await readdir('/proc').catch(() => undefined);
  if (pids === undefined) {
    return true;
  }
  return scanForLiveMember(
    pids.filter((name) => /^\d+$/u.test(name)),
    0,
    processGroupId,
  );
}

async function scanForLiveMember(
  pids: readonly string[],
  index: number,
  processGroupId: number,
): Promise<boolean> {
  const pid = pids[index];
  if (pid === undefined) {
    return false;
  }
  if (await memberMayBeLive(pid, processGroupId)) {
    return true;
  }
  return scanForLiveMember(pids, index + 1, processGroupId);
}

// Answers false only for a PID positively ruled out: one that vanished mid-scan, one belonging
// to another group, or a zombie of this group. An unreadable or malformed entry answers true.
async function memberMayBeLive(pid: string, processGroupId: number): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    return !vanishedProcess(error);
  }
  const named = raw.lastIndexOf(') ');
  if (named < 0) {
    return true;
  }
  const [state, , group] = raw.slice(named + 2).split(' ');
  if (state === undefined || state === '' || group === undefined || !/^\d+$/u.test(group)) {
    return true;
  }
  return Number(group) === processGroupId && state !== 'Z';
}

const vanishedProcess = (error: unknown): boolean =>
  errorCode(error) === 'ENOENT' || errorCode(error) === 'ESRCH';

async function pollProcessExit(pid: number, remaining: number): Promise<boolean> {
  if (remaining === 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    return errorCode(error) === 'ESRCH';
  }
  await delay(10);
  return pollProcessExit(pid, remaining - 1);
}

// A historical PID may already name an unrelated process, so absence is read from /proc alone and
// never probed with a signal. A collected entry and a zombie awaiting a reaper both count as gone.
async function pollProcessAbsent(pid: number, remaining: number): Promise<boolean> {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8').then(
    (value) => value,
    () => undefined,
  );
  if (raw === undefined) {
    return true;
  }
  const named = raw.lastIndexOf(') ');
  if (named >= 0 && raw.slice(named + 2).split(' ')[0] === 'Z') {
    return true;
  }
  if (remaining === 0) {
    return false;
  }
  await delay(10);
  return pollProcessAbsent(pid, remaining - 1);
}

function errorCode(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'code' in value ? value.code : undefined;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
