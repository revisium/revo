import { fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type ChildResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};
type NodeAttempt = { readonly stage: string; readonly executable: string };
type NodeInput = Record<string, unknown>;

const PUBLISHER_CHILD_TIMEOUT_MS = 15_000;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const emitChunks = (chunks: readonly string[] | undefined, fallback: string, fd = '') =>
  (chunks ?? [fallback])
    .map(
      (chunk, index, values) =>
        `printf '%s' ${shellQuote(chunk)}${fd}${index + 1 < values.length ? '\nsleep 0.01' : ''}`,
    )
    .join('\n');

export async function pnpmBootstrapScenario(
  enginePath: string,
  bootstrap: unknown,
  { temporaryParent = tmpdir() }: { readonly temporaryParent?: string } = {},
) {
  const root = await realpath(await mkdtemp(join(temporaryParent, 'revo-bootstrap-data-')));
  const dataPath = join(root, 'bootstrap.json');
  const receiptPath = join(root, 'install-receipt.json');
  const nodeExecutable = join(root, 'node');
  const nodeStage = join(root, 'node-stage');
  await writeFile(nodeExecutable, '#!/bin/sh\nexit 0\n');
  await chmod(nodeExecutable, 0o755);
  const write = (value: unknown) =>
    writeFile(dataPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await write(bootstrap);
  const runDirect = (target: string, archiveSha256: string) =>
    new Promise<ChildResult>((done) => {
      const child = spawn(process.execPath, [enginePath, dataPath], {
        env: {
          ...process.env,
          REVO_NODE_TARGET: target,
          REVO_NODE_ARCHIVE_SHA256: archiveSha256,
          REVO_RECEIPT_PATH: receiptPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.once('close', (code, signal) => done({ code, signal, stdout, stderr }));
    });
  return {
    root,
    dataPath,
    receiptPath,
    nodeExecutable,
    nodeStage,
    prepareNodeStage: async (label = '', inChannel = false) => {
      const stage =
        label === ''
          ? nodeStage
          : join(inChannel ? join(root, 'channel') : root, `node-stage-${label}`);
      await mkdir(stage, { recursive: true });
      const executable = join(stage, 'bin', 'node');
      await mkdir(join(stage, 'bin'));
      await mkdir(join(stage, 'include'));
      await mkdir(join(stage, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
      await mkdir(join(stage, 'share', 'doc'), { recursive: true });
      await copyFile(process.execPath, executable);
      await chmod(executable, 0o755);
      await writeFile(join(stage, 'include', 'node.h'), 'native node header\n');
      await writeFile(
        join(stage, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        'export {}\n',
      );
      await symlink('../lib/node_modules/npm/bin/npm-cli.js', join(stage, 'bin', 'npm'));
      await writeFile(join(stage, 'share', 'doc', 'README'), 'native node docs\n');
      return { stage, executable };
    },
    publishNodeTogether: async (attempts: NodeAttempt[], input: NodeInput) => {
      const script = fileURLToPath(new URL('./node-publication-process.mjs', import.meta.url));
      const testPublisherMode = input.testPublisherMode;
      const publicationInput = { ...input };
      delete publicationInput.testPublisherMode;
      const children = attempts.map(() =>
        fork(script, [], {
          env: {
            ...process.env,
            ...(typeof testPublisherMode === 'string'
              ? { REVO_TEST_PUBLISHER_MODE: testPublisherMode }
              : {}),
          },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        }),
      );
      const exits = children.map((child) => childExit(child));
      try {
        await Promise.all(children.map((child) => waitForPublisherMessage(child, 'ready')));
        const outcomes = children.map(async (child, index) => {
          const attempt = attempts[index];
          if (attempt === undefined) {
            throw new Error('node publication attempt is missing');
          }
          child.send({ ...publicationInput, stage: attempt.stage });
          return waitForPublisherMessage(child, 'result');
        });
        const results = await Promise.all(outcomes);
        await Promise.all(exits.map((exit) => withTimeout(exit, PUBLISHER_CHILD_TIMEOUT_MS)));
        return results;
      } finally {
        await stopPublisherChildren(children, exits);
      }
    },
    write,
    receipt: async () => readFile(receiptPath, 'utf8').catch(() => undefined),
    receiptMode: async () =>
      stat(receiptPath)
        .then((info) => info.mode & 0o777)
        .catch(() => undefined),
    runDirect,
    archive: async ({
      hardlink = false,
      version = '12.5.1',
      shebang = '#!/bin/sh',
      probeStdout,
      probeStderr,
      stdoutChunks,
      stderrChunks,
      probeExitCode = 0,
      probeCwd = 'isolated',
      probeHome = 'isolated',
    }: {
      readonly hardlink?: boolean;
      readonly version?: string;
      readonly shebang?: string;
      readonly probeStdout?: string;
      readonly probeStderr?: string;
      readonly stdoutChunks?: readonly string[];
      readonly stderrChunks?: readonly string[];
      readonly probeExitCode?: number;
      readonly probeCwd?: 'isolated' | 'outside-spoofed-pwd';
      readonly probeHome?: 'isolated' | 'wrong';
    } = {}) => {
      const source = await mkdtemp(join(root, 'payload-'));
      await mkdir(join(source, 'dist'));
      await writeFile(
        join(source, 'pnpm'),
        `${shebang}
set -eu
if [ "$1" != "--pm-on-fail=ignore" ] || [ "$2" != "--version" ]; then
  echo "pnpm probe arguments were not isolated" >&2
  exit 91
fi
${probeCwd === 'outside-spoofed-pwd' ? `cd /\nPWD=${shellQuote(`${root}/.pnpm-probe-spoof`)}` : ''}
${probeHome === 'wrong' ? 'HOME=/' : ''}
probe_cwd=$(pwd -P)
test "\${probe_cwd%/*}" = ${shellQuote(root)} || { echo "pnpm probe cwd was not isolated" >&2; exit 92; }
case "\${probe_cwd##*/}" in .pnpm-probe-?*) ;; *) echo "pnpm probe cwd was not isolated" >&2; exit 92 ;; esac
test "$HOME" = "$probe_cwd/home" || { echo "pnpm probe home was not isolated" >&2; exit 93; }
test "$TMPDIR" = "$probe_cwd" || exit 98
test "$XDG_CONFIG_HOME" = "$probe_cwd/config" && test -d "$XDG_CONFIG_HOME" || exit 94
test "$XDG_CACHE_HOME" = "$probe_cwd/cache" && test -d "$XDG_CACHE_HOME" || exit 95
test "$XDG_DATA_HOME" = "$probe_cwd/data" && test -d "$XDG_DATA_HOME" || exit 96
test "$XDG_STATE_HOME" = "$probe_cwd/state" && test -d "$XDG_STATE_HOME" || exit 97
${emitChunks(stdoutChunks, probeStdout ?? `${version}\n`)}
${emitChunks(stderrChunks, probeStderr ?? '', ' >&2')}
exit ${probeExitCode}
`,
      );
      await chmod(join(source, 'pnpm'), 0o755);
      await writeFile(join(source, 'dist', 'index.js'), 'export {}\n');
      if (hardlink) {
        await link(join(source, 'dist', 'index.js'), join(source, 'dist', 'copy.js'));
      }
      const archivePath = join(root, 'pnpm.tar.gz');
      await new Promise<void>((resolve, reject) => {
        const child = spawn('tar', ['-czf', archivePath, '-C', source, '.'], {
          shell: false,
          stdio: 'ignore',
        });
        child.once('error', reject);
        child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar ${code}`))));
      });
      const bytes = await readFile(archivePath);
      await rm(source, { recursive: true, force: true });
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
  };
}

type PublisherMessage = {
  readonly ready?: boolean;
  readonly ok?: boolean;
  readonly result?: unknown;
};

function waitForPublisherMessage(
  child: ReturnType<typeof fork>,
  expected: 'ready' | 'result',
): Promise<PublisherMessage> {
  return withTimeout(
    new Promise<PublisherMessage>((resolve, reject) => {
      const onMessage = (message: PublisherMessage) => {
        if (
          (expected === 'ready' && message.ready === true) ||
          (expected === 'result' && 'ok' in message)
        ) {
          cleanup();
          resolve(message);
        }
      };
      const onError = () => {
        cleanup();
        reject(new Error(`publisher child ${expected} IPC failed`));
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(
          new Error(`publisher child exited before ${expected} (code=${code}, signal=${signal})`),
        );
      };
      const cleanup = () => {
        child.off('message', onMessage);
        child.off('error', onError);
        child.off('exit', onExit);
      };
      child.on('message', onMessage);
      child.once('error', onError);
      child.once('exit', onExit);
    }),
    PUBLISHER_CHILD_TIMEOUT_MS,
  );
}

function childExit(child: ReturnType<typeof fork>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function stopPublisherChildren(
  children: readonly ReturnType<typeof fork>[],
  exits: readonly Promise<void>[],
): Promise<void> {
  for (const child of children) {
    if (child.connected) {
      child.disconnect();
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }
  await Promise.all(exits.map((exit) => withTimeout(exit, 1000).catch(() => undefined)));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('publisher child observation timed out')),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
