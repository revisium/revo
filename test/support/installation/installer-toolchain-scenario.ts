// oxlint-disable no-unsafe-type-assertion, typescript/unbound-method -- ordered bounded diagnostics and dynamic builder fixture
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { release as osRelease, tmpdir } from 'node:os';
import { join, relative as relativePath, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { vi } from 'vitest';

import { LoopbackPortAllocator } from '../../../src/postgres/loopback-port-allocator.js';
import { ServerStatusService } from '../../../src/server/server-status.service.js';
import { ServerStopService } from '../../../src/server/server-stop.service.js';
import { assertActivationTestModes } from './activation-test-modes.js';
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
const installedData = new Map<string, Set<string>>();
const INTEL_FILE_LIMIT = 64 * 1024;
const INTEL_BUNDLE_LIMIT = 1536 * 1024;
const INTEL_SUMMARY_RESERVE = 128 * 1024;
const INTEL_COLLECTOR_KILL_AT = 4_000;
const INTEL_COLLECTOR_DEADLINE = 5_000;
const INITIAL_INSTALL_DIAGNOSTIC_MAX_ENTRIES = 64;
const INITIAL_INSTALL_DIAGNOSTIC_TAIL_BYTES = 4096;
const INITIAL_INSTALL_DIAGNOSTIC_OUTPUT_BYTES = 16 * 1024;
const INTEL_ENVIRONMENT_KEYS = [
  'REVO_INTEL_DIAGNOSTICS_DIR',
  'REVO_INTEL_BASE_SHA',
  'REVO_INTEL_HEAD_SHA',
  'REVO_INTEL_PNPM_VERSION',
] as const;
const intelCollectorState = {
  bytes: 0,
  complete: true,
  issues: [] as string[],
  omissions: [] as Record<string, unknown>[],
  omissionOverflow: 0,
};
const intelCollectors = new Set<ChildProcess>();
const intelInvocationInventories = new Map<string, Map<string, unknown>>();
const intelFixtureRoots = new Set<string>();
const intelCanonicalFixtureRoots = new Map<string, string>();
const intelContextIds = new Map<string, string>();
let nextIntelContextId = 0;
const INTEL_CONFIGURATION_ENVIRONMENT_KEYS = [
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'REVO_CHANNEL',
  'REVO_CONFIG',
  'REVO_DATABASE_URL',
  'REVO_DATA_DIR',
  'REVO_HOST',
  'REVO_LOG_DIR',
  'REVO_PORT',
  'REVO_PUBLIC_URL',
  'REVO_STARTUP_TIMEOUT',
] as const;

interface IntelFixtureContext {
  readonly root: string;
  readonly homeDir: string;
  readonly installRoot: string;
  readonly channelRoot: string;
  readonly channel: 'stable' | 'alpha';
  readonly dataDir: string;
  readonly port: number;
  readonly pnpmNodeRecord: string;
  readonly packageVersion: string;
  readonly nodeVersion: string;
  readonly targetArchitecture: string;
  readonly platform: 'darwin' | 'linux';
  readonly configurationEnvironment: Readonly<Record<string, string | undefined>>;
}

interface IntelLifecycleExpectation {
  readonly root: string;
  readonly expectation: 'required' | 'absent-permitted' | 'unknown';
  readonly reason: string;
}

function intelDiagnosticsDirectory(): string | undefined {
  const configured = process.env.REVO_INTEL_DIAGNOSTICS_DIR;
  return configured ? resolvePath(configured) : undefined;
}

function redactDiagnosticText(value: string, roots: readonly string[] = []): string {
  let result = value
    .replace(/\b(postgres(?:ql)?:\/\/)[^\s/@]+@/giu, '$1[redacted]@')
    .replace(
      /\b(password|secret|token|authorization|cookie)(\s*[:=]\s*)(["']?)[^\s,;"']+/giu,
      '$1$2[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [redacted]');
  for (const root of [...roots].sort((left, right) => right.length - left.length)) {
    result = result.replaceAll(root, '<fixture>');
  }
  return result;
}

type InitialInstallDiagnosticStatus =
  | 'captured'
  | 'missing'
  | 'ambiguous'
  | 'unsafe'
  | 'io-error'
  | 'too-large';

interface InitialInstallDiagnosticFile {
  readonly label: string;
  readonly status: InitialInstallDiagnosticStatus;
  readonly sizeBytes: number | null;
  readonly truncated: boolean;
  readonly tail?: string;
}

function initialDiagnosticErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = relativePath(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${sep}`));
}

async function inspectFixtureDirectory(
  canonicalRoot: string,
  segments: readonly string[],
): Promise<{ readonly status: 'ok' | 'missing' | 'unsafe' | 'io-error'; readonly path: string }> {
  let current = canonicalRoot;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.includes(sep)) {
      return { status: 'unsafe', path: current };
    }
    current = join(current, segment);
    let metadata;
    try {
      // oxlint-disable-next-line no-await-in-loop -- each path component must be validated before resolving the next one.
      metadata = await lstat(current);
    } catch (error) {
      return {
        status: initialDiagnosticErrorCode(error) === 'ENOENT' ? 'missing' : 'io-error',
        path: current,
      };
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return { status: 'unsafe', path: current };
    }
  }
  return { status: 'ok', path: current };
}

async function listFixtureEntries(directory: string): Promise<{
  readonly status: 'ok' | 'missing' | 'unsafe' | 'io-error' | 'limit-reached';
  readonly names: readonly string[];
}> {
  const names: string[] = [];
  let handle;
  try {
    handle = await opendir(directory);
    for await (const entry of handle) {
      names.push(entry.name);
      if (names.length === INITIAL_INSTALL_DIAGNOSTIC_MAX_ENTRIES) {
        return { status: 'limit-reached', names };
      }
    }
    return { status: 'ok', names };
  } catch (error) {
    return {
      status: initialDiagnosticErrorCode(error) === 'ENOENT' ? 'missing' : 'io-error',
      names,
    };
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}

function cleanInitialDiagnosticText(value: string, roots: readonly string[]): string {
  const withoutControls = value
    // oxlint-disable-next-line no-control-regex -- remove ANSI escape sequences from untrusted diagnostic text.
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu, '')
    // oxlint-disable-next-line no-control-regex -- strip remaining ASCII and C1 control bytes before redaction.
    .replace(/[\u0000-\u0008\u000b-\u000d\u000e-\u001f\u007f-\u009f]/gu, '');
  return redactDiagnosticText(withoutControls, roots);
}

async function readInitialDiagnosticFile(
  canonicalRoot: string,
  relativeSegments: readonly string[],
  label: string,
  rootsToRedact: readonly string[],
): Promise<InitialInstallDiagnosticFile> {
  const parent = await inspectFixtureDirectory(canonicalRoot, relativeSegments.slice(0, -1));
  if (parent.status !== 'ok') {
    return {
      label,
      status: parent.status === 'io-error' ? 'io-error' : parent.status,
      sizeBytes: null,
      truncated: false,
    };
  }

  const path = join(parent.path, relativeSegments.at(-1) ?? '');
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    return {
      label,
      status: initialDiagnosticErrorCode(error) === 'ENOENT' ? 'missing' : 'io-error',
      sizeBytes: null,
      truncated: false,
    };
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    return { label, status: 'unsafe', sizeBytes: null, truncated: false };
  }

  let file;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await file.stat();
    if (!opened.isFile() || !Number.isSafeInteger(opened.size) || opened.size < 0) {
      return { label, status: 'unsafe', sizeBytes: null, truncated: false };
    }
    const sizeBytes = opened.size;
    const readBytes = Math.min(sizeBytes, INITIAL_INSTALL_DIAGNOSTIC_TAIL_BYTES);
    const offset = sizeBytes - readBytes;
    const buffer = Buffer.alloc(readBytes);
    const { bytesRead } = await file.read(buffer, 0, readBytes, offset);
    if (bytesRead !== readBytes) {
      return { label, status: 'io-error', sizeBytes, truncated: sizeBytes > readBytes };
    }

    let text = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    if (offset > 0) {
      lines.shift();
    }
    if (lines.at(-1) === '') {
      lines.pop();
    } else if (lines.length > 0) {
      lines.pop();
    }
    text = lines.join('\n');
    const tail = cleanInitialDiagnosticText(text, rootsToRedact);
    return {
      label,
      status: 'captured',
      sizeBytes,
      truncated: offset > 0,
      ...(tail.length === 0 ? {} : { tail }),
    };
  } catch (error) {
    return {
      label,
      status: initialDiagnosticErrorCode(error) === 'ENOENT' ? 'missing' : 'io-error',
      sizeBytes: null,
      truncated: false,
    };
  } finally {
    await file?.close().catch(() => undefined);
  }
}

/** @internal Test-only bounded collector; production callers use the fixture-bound closure. */
export async function collectInitialInstallFailureDiagnostics(
  fixtureRoot: string,
  fixtureChannelRoot: string,
): Promise<string> {
  const lines: string[] = [];
  const prefix = 'POSIX_INSTALL_DIAGNOSTIC ';
  const truncationMarker = `${prefix}status=output-truncated`;
  const outputBudget =
    INITIAL_INSTALL_DIAGNOSTIC_OUTPUT_BYTES - Buffer.byteLength(`${truncationMarker}\n`);
  let emittedBytes = 0;
  let outputTruncated = false;
  const emit = (line: string) => {
    if (outputTruncated) {
      return;
    }
    const rendered = `${prefix}${line}`;
    const lineBytes = Buffer.byteLength(rendered) + 1;
    if (emittedBytes + lineBytes > outputBudget) {
      outputTruncated = true;
      return;
    }
    lines.push(rendered);
    emittedBytes += lineBytes;
  };
  const finish = () => `${[...lines, ...(outputTruncated ? [truncationMarker] : [])].join('\n')}\n`;
  try {
    const canonicalRoot = await realpath(fixtureRoot);
    const canonicalRootStat = await lstat(canonicalRoot);
    if (canonicalRootStat.isSymbolicLink() || !canonicalRootStat.isDirectory()) {
      return 'POSIX_INSTALL_DIAGNOSTIC status=diagnostics-incomplete reason=unsafe-fixture-root\n';
    }
    const relativeChannelRoot = relativePath(
      resolvePath(fixtureRoot),
      resolvePath(fixtureChannelRoot),
    );
    if (!isPathWithin(resolvePath(fixtureRoot), resolvePath(fixtureChannelRoot))) {
      return 'POSIX_INSTALL_DIAGNOSTIC status=diagnostics-incomplete reason=channel-outside-fixture\n';
    }
    const channelSegments = relativeChannelRoot ? relativeChannelRoot.split(sep) : [];
    const channel = await inspectFixtureDirectory(canonicalRoot, channelSegments);
    if (channel.status !== 'ok') {
      emit(
        `status=${channel.status === 'missing' ? 'complete' : 'diagnostics-incomplete'} attempts=${channel.status}`,
      );
      for (const label of ['install-session.log', 'server-start.log', 'activation-result.log']) {
        emit(
          `${label} status=${channel.status === 'missing' ? 'missing' : channel.status} sizeBytes=unknown truncated=false`,
        );
      }
      return finish();
    }

    const attemptsListing = await listFixtureEntries(channel.path);
    const attemptNames = attemptsListing.names.filter((name) =>
      /^\.attempt\.[A-Za-z0-9_-]+$/u.test(name),
    );
    const attemptName = attemptNames[0];
    if (attemptsListing.status !== 'ok' || attemptNames.length !== 1 || attemptName === undefined) {
      const attemptStatus =
        attemptsListing.status === 'limit-reached' || attemptNames.length > 1
          ? 'ambiguous'
          : attemptsListing.status === 'missing'
            ? 'missing'
            : attemptsListing.status === 'ok'
              ? 'missing'
              : 'io-error';
      emit(
        `status=${attemptStatus === 'io-error' ? 'diagnostics-incomplete' : 'complete'} attempts=${attemptStatus}`,
      );
      for (const label of ['install-session.log', 'server-start.log', 'activation-result.log']) {
        emit(`${label} status=${attemptStatus} sizeBytes=unknown truncated=false`);
      }
      return finish();
    }

    const attempt = await inspectFixtureDirectory(canonicalRoot, [...channelSegments, attemptName]);
    if (attempt.status !== 'ok') {
      emit(`status=diagnostics-incomplete attempts=${attempt.status}`);
      for (const label of ['install-session.log', 'server-start.log', 'activation-result.log']) {
        emit(`${label} status=${attempt.status} sizeBytes=unknown truncated=false`);
      }
      return finish();
    }
    const scratch = await inspectFixtureDirectory(canonicalRoot, [
      ...channelSegments,
      attemptName,
      'runtime',
      'scratch',
    ]);
    if (scratch.status !== 'ok') {
      emit(
        `status=${scratch.status === 'missing' ? 'complete' : 'diagnostics-incomplete'} attempts=1 scratch=${scratch.status}`,
      );
      for (const label of ['install-session.log', 'server-start.log', 'activation-result.log']) {
        emit(`${label} status=${scratch.status} sizeBytes=unknown truncated=false`);
      }
      return finish();
    }

    const activationListing = await listFixtureEntries(scratch.path);
    const activationNames = activationListing.names.filter((name) =>
      /^\.activation-request-[A-Za-z0-9_-]+$/u.test(name),
    );
    const activationName = activationNames[0];
    const activationStatus =
      activationListing.status === 'limit-reached' || activationNames.length > 1
        ? 'ambiguous'
        : activationListing.status === 'missing'
          ? 'missing'
          : activationListing.status === 'ok'
            ? activationNames.length === 0
              ? 'missing'
              : 'captured'
            : 'io-error';
    if (activationNames.length === 1 && activationName !== undefined) {
      const activationDirectory = await inspectFixtureDirectory(canonicalRoot, [
        ...channelSegments,
        attemptName,
        'runtime',
        'scratch',
        activationName,
      ]);
      if (activationDirectory.status !== 'ok') {
        emit(
          `status=diagnostics-incomplete attempts=1 activationRequest=${activationDirectory.status}`,
        );
      }
    }

    const rootsToRedact = [fixtureRoot, fixtureChannelRoot, canonicalRoot, channel.path];
    const files: InitialInstallDiagnosticFile[] = [
      await readInitialDiagnosticFile(
        canonicalRoot,
        [...channelSegments, attemptName, 'runtime', 'scratch', 'install-session.log'],
        'install-session.log',
        rootsToRedact,
      ),
      await readInitialDiagnosticFile(
        canonicalRoot,
        [...channelSegments, attemptName, 'runtime', 'scratch', 'server-start.log'],
        'server-start.log',
        rootsToRedact,
      ),
      activationNames.length === 1 &&
      activationName !== undefined &&
      activationStatus === 'captured'
        ? await readInitialDiagnosticFile(
            canonicalRoot,
            [...channelSegments, attemptName, 'runtime', 'scratch', activationName, 'result.log'],
            'activation-result.log',
            rootsToRedact,
          )
        : {
            label: 'activation-result.log',
            status: activationStatus,
            sizeBytes: null,
            truncated: false,
          },
    ];
    const incomplete =
      attemptsListing.status !== 'ok' ||
      activationStatus === 'io-error' ||
      files.some((file) => ['unsafe', 'io-error', 'too-large'].includes(file.status));
    emit(
      `status=${incomplete ? 'diagnostics-incomplete' : 'complete'} attempts=1 activationRequest=${activationStatus}`,
    );
    for (const file of files) {
      emit(
        `${file.label} status=${file.status} sizeBytes=${file.sizeBytes ?? 'unknown'} truncated=${file.truncated}`,
      );
      if (file.tail) {
        for (const line of file.tail.split('\n')) {
          emit(`${file.label} | ${line}`);
        }
      } else if (file.status === 'captured') {
        emit(`${file.label} | tail-unavailable`);
      }
    }
  } catch {
    return 'POSIX_INSTALL_DIAGNOSTIC status=diagnostics-incomplete reason=collector-error\n';
  }

  return finish();
}

/** @internal Test-only collector for a caller-identified retained attempt. */
export async function collectInstallAttemptDiagnostics(
  fixtureRoot: string,
  fixtureChannelRoot: string,
  attemptName: string | undefined,
): Promise<string> {
  const prefix = 'POSIX_INSTALL_DIAGNOSTIC ';
  const truncationMarker = `${prefix}status=output-truncated`;
  const outputBudget =
    INITIAL_INSTALL_DIAGNOSTIC_OUTPUT_BYTES - Buffer.byteLength(`${truncationMarker}\n`);
  const lines: string[] = [];
  let emittedBytes = 0;
  let outputTruncated = false;
  const emit = (line: string) => {
    if (outputTruncated) {
      return;
    }
    const rendered = `${prefix}${line}`;
    const lineBytes = Buffer.byteLength(rendered) + 1;
    if (emittedBytes + lineBytes > outputBudget) {
      outputTruncated = true;
      return;
    }
    lines.push(rendered);
    emittedBytes += lineBytes;
  };
  const finish = () => `${[...lines, ...(outputTruncated ? [truncationMarker] : [])].join('\n')}\n`;
  try {
    if (attemptName === undefined || !/^\.attempt\.[A-Za-z0-9_-]+$/u.test(attemptName)) {
      emit('status=attempt-unresolved reason=invalid-attempt-name');
      return finish();
    }
    const canonicalRoot = await realpath(fixtureRoot);
    const rootStat = await lstat(canonicalRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      emit('status=diagnostics-incomplete reason=unsafe-fixture-root');
      return finish();
    }
    if (!isPathWithin(resolvePath(fixtureRoot), resolvePath(fixtureChannelRoot))) {
      emit('status=diagnostics-incomplete reason=channel-outside-fixture');
      return finish();
    }
    const channelRelative = relativePath(resolvePath(fixtureRoot), resolvePath(fixtureChannelRoot));
    const channelSegments = channelRelative ? channelRelative.split(sep) : [];
    const attempt = await inspectFixtureDirectory(canonicalRoot, [...channelSegments, attemptName]);
    if (attempt.status !== 'ok') {
      emit(
        `status=${attempt.status === 'missing' ? 'complete' : 'diagnostics-incomplete'} attempt=${attemptName} attemptStatus=${attempt.status}`,
      );
      return finish();
    }
    const scratch = await inspectFixtureDirectory(canonicalRoot, [
      ...channelSegments,
      attemptName,
      'runtime',
      'scratch',
    ]);
    if (scratch.status !== 'ok') {
      emit(
        `status=${scratch.status === 'missing' ? 'complete' : 'diagnostics-incomplete'} attempt=${attemptName} scratch=${scratch.status}`,
      );
      return finish();
    }
    const rootsToRedact = [fixtureRoot, fixtureChannelRoot, canonicalRoot, attempt.path];
    const files: InitialInstallDiagnosticFile[] = [
      await readInitialDiagnosticFile(
        canonicalRoot,
        [...channelSegments, attemptName, 'runtime', 'scratch', 'install-session.log'],
        'install-session.log',
        rootsToRedact,
      ),
      await readInitialDiagnosticFile(
        canonicalRoot,
        [...channelSegments, attemptName, 'runtime', 'scratch', 'server-start.log'],
        'server-start.log',
        rootsToRedact,
      ),
    ];
    const activationListing = await listFixtureEntries(scratch.path);
    const activationNames = activationListing.names.filter((name) =>
      /^\.activation-request-[A-Za-z0-9_-]+$/u.test(name),
    );
    const activationName = activationNames[0];
    if (activationNames.length === 1 && activationName !== undefined) {
      files.push(
        await readInitialDiagnosticFile(
          canonicalRoot,
          [...channelSegments, attemptName, 'runtime', 'scratch', activationName, 'result.log'],
          'activation-result.log',
          rootsToRedact,
        ),
      );
    } else {
      files.push({
        label: 'activation-result.log',
        status:
          activationListing.status === 'ok' && activationNames.length === 0
            ? 'missing'
            : activationNames.length > 1 || activationListing.status === 'limit-reached'
              ? 'ambiguous'
              : 'io-error',
        sizeBytes: null,
        truncated: false,
      });
    }
    const incomplete = files.some((file) =>
      ['unsafe', 'io-error', 'too-large'].includes(file.status),
    );
    emit(
      `status=${incomplete ? 'diagnostics-incomplete' : 'complete'} attempt=${attemptName} activationRequest=${activationNames.length === 1 ? 'captured' : 'unresolved'}`,
    );
    for (const file of files) {
      emit(
        `${file.label} status=${file.status} sizeBytes=${file.sizeBytes ?? 'unknown'} truncated=${file.truncated}`,
      );
      if (file.tail) {
        for (const line of file.tail.split('\n')) {
          emit(`${file.label} | ${line}`);
        }
      } else if (file.status === 'captured') {
        emit(`${file.label} | tail-unavailable`);
      }
    }
  } catch {
    emit('status=diagnostics-incomplete reason=collector-error');
  }
  return finish();
}

function appendDiagnosticTail(previous: string, chunk: string): string {
  const bytes = Buffer.from(`${previous}${chunk}`, 'utf8');
  return bytes.length <= INTEL_FILE_LIMIT
    ? bytes.toString('utf8')
    : bytes.subarray(bytes.length - INTEL_FILE_LIMIT).toString('utf8');
}

function safeFailureSummary(error: unknown, roots: readonly string[]): string {
  const message = error instanceof Error ? error.message : 'non-error failure';
  return redactDiagnosticText(message, roots).replace(/\s+/gu, ' ').slice(-1024);
}

const INTEL_COLLECTOR_SOURCE = String.raw`
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath, readlink, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

const FILE_LIMIT = 64 * 1024;
const BUNDLE_LIMIT = 1536 * 1024;
const SUMMARY_RESERVE = 128 * 1024;
const isInside = (root, candidate) => {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path));
};
const redact = (value, roots) => {
  let result = value
    .replace(/\b(postgres(?:ql)?:\/\/)[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/\b(password|secret|token|authorization|cookie)(\s*[:=]\s*)(["']?)[^\s,;"']+/giu, '$1$2[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [redacted]');
  for (const root of [...roots].sort((a, b) => b.length - a.length)) result = result.split(root).join('<fixture>');
  return result;
};
const errorCode = (error) => error && typeof error === 'object' ? error.code : undefined;
const plainStat = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
const rootPaths = (context) => [context.root, context.installRoot].filter(Boolean);
const redactionRoots = (context) => [...rootPaths(context), context.homeDir].filter(Boolean);

async function canonicalDirectory(path) {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  const components = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    const candidate = join(current, components[index]);
    let metadata;
    try { metadata = await lstat(candidate); }
    catch (error) {
      if (errorCode(error) !== 'ENOENT') return { status: 'unsafe' };
      const missing = [components[index], ...components.slice(index + 1)];
      return { status: 'missing-parent', canonical: resolve(current, ...missing) };
    }
    if (metadata.isSymbolicLink()) {
      let actual;
      try { actual = await realpath(candidate); } catch { return { status: 'unsafe' }; }
      if (process.platform !== 'darwin' || candidate !== '/tmp' || actual !== '/private/tmp') {
        return { status: 'unsafe' };
      }
      current = actual;
      continue;
    }
    if (!metadata.isDirectory()) return { status: 'unsafe' };
    current = candidate;
  }
  return { status: 'captured', canonical: current };
}

async function trustedCanonicalPath(path, roots) {
  const absolute = resolve(path);
  const lexicalRoot = roots.find((root) => isInside(root, absolute));
  if (!lexicalRoot) return { status: 'unapproved-path' };
  const root = await canonicalDirectory(lexicalRoot);
  if (root.status !== 'captured') return { status: 'unapproved-path' };
  const canonicalRoot = root.canonical;
  if (absolute === resolve(lexicalRoot)) return { status: 'ok', canonicalRoot, canonical: canonicalRoot };
  const parent = await canonicalDirectory(dirname(absolute));
  if (parent.status === 'unsafe') return { status: 'unsafe' };
  if (parent.status === 'missing-parent') {
    const candidate = resolve(parent.canonical, absolute.split(sep).at(-1));
    return isInside(canonicalRoot, candidate)
      ? { status: 'missing-parent', canonicalRoot, canonical: candidate }
      : { status: 'unapproved-path' };
  }
  if (!isInside(canonicalRoot, parent.canonical)) return { status: 'unapproved-path' };
  try {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) return { status: 'unsafe' };
    const canonical = await realpath(absolute);
    return isInside(canonicalRoot, canonical)
      ? { status: 'ok', canonicalRoot, canonical }
      : { status: 'unapproved-path' };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      const candidate = resolve(parent.canonical, absolute.split(sep).at(-1));
      return isInside(canonicalRoot, candidate)
        ? { status: 'missing-parent', canonicalRoot, canonical: candidate }
        : { status: 'unapproved-path' };
    }
    return { status: 'unsafe' };
  }
}

async function readChecked(path, allowedPaths, limit = FILE_LIMIT, tail = false, requirePrivate = false) {
  if (!allowedPaths.some((allowed) => resolve(allowed) === resolve(path))) {
    return { status: 'unapproved-path' };
  }
  const absolute = resolve(path);
  const parent = await canonicalDirectory(dirname(absolute));
  if (parent.status === 'unsafe') return { status: 'unsafe' };
  if (parent.status === 'missing-parent') return { status: 'missing' };
  if (parent.status !== 'captured') return { status: 'io-error' };
  let before;
  try { before = await lstat(absolute); } catch (error) {
    return { status: errorCode(error) === 'ENOENT' ? 'missing' : 'io-error' };
  }
  if (!before.isFile() || before.isSymbolicLink()) return { status: 'unsafe' };
  let canonical;
  try { canonical = await realpath(absolute); } catch { return { status: 'io-error' }; }
  if (canonical !== join(parent.canonical, absolute.split(sep).at(-1))) return { status: 'unsafe' };
  let file;
  try { file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return { status: errorCode(error) === 'ENOENT' ? 'missing' : 'io-error' }; }
  try {
    const after = await file.stat({ bigint: true });
    if (!after.isFile() || String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino)) return { status: 'unsafe' };
    const ownedPrivate = currentUid() !== undefined &&
      String(after.uid) === String(currentUid()) &&
      (after.mode & 0o7777n) === 0o600n &&
      after.nlink === 1n;
    if (requirePrivate && !ownedPrivate) return { status: 'unsafe' };
    if (!Number.isSafeInteger(Number(after.size))) return { status: 'too-large', size: FILE_LIMIT + 1 };
    const length = Math.min(Number(after.size), limit + (tail ? 0 : 1));
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, tail ? Number(after.size) - length : 0);
    if (!tail && Number(after.size) > limit) return { status: 'too-large', size: Number(after.size) };
    return { status: 'captured', text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: Number(after.size) > bytesRead, ownedPrivate, facts: plainStat(after), digest: createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex') };
  } finally { await file.close().catch(() => undefined); }
}

async function safeDirectory(path, roots) {
  const trusted = await trustedCanonicalPath(path, roots);
  if (trusted.status === 'missing-parent') return { status: 'missing' };
  if (trusted.status !== 'ok') return { status: trusted.status };
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return { status: 'unsafe' };
    return { status: 'captured', canonical: trusted.canonical };
  } catch (error) { return { status: errorCode(error) === 'ENOENT' ? 'missing' : 'io-error' }; }
}

const currentUid = () => typeof process.getuid === 'function' ? process.getuid() : undefined;
const isPrivateDirectory = (metadata, uid) => metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === uid && (metadata.mode & 0o7777) === 0o700;
const isPrivateRegularFile = (metadata, uid) => metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === uid && (metadata.mode & 0o7777) === 0o600 && metadata.nlink === 1;

async function validateOutputAncestors(path, outputRoot) {
  const uid = currentUid();
  if (uid === undefined) return false;
  const absolute = resolve(path);
  const canonicalRoot = resolve(outputRoot);
  if (!isInside(canonicalRoot, absolute)) return false;
  const { root } = parse(absolute);
  const components = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let metadata;
    try { metadata = await lstat(current); }
    catch (error) {
      return errorCode(error) === 'ENOENT';
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
    const insideOutputTree = isInside(canonicalRoot, current);
    if (insideOutputTree) {
      if (!isPrivateDirectory(metadata, uid)) return false;
      continue;
    }
    if (metadata.uid !== uid && metadata.uid !== 0) return false;
    if ((metadata.mode & 0o0022) === 0) continue;
    const trustedTemp = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
    if (current !== trustedTemp || metadata.uid !== 0 || (metadata.mode & 0o1777) !== 0o1777) return false;
  }
  return true;
}

async function ensureDirectory(path, outputRoot) {
  const absolute = resolve(path);
  const trust = await canonicalDirectory(absolute);
  if (!['captured', 'missing-parent'].includes(trust.status) || trust.canonical !== absolute) {
    throw new Error('unsafe diagnostic output directory');
  }
  if (!(await validateOutputAncestors(absolute, outputRoot))) {
    throw new Error('unsafe diagnostic output directory');
  }
  const { root } = parse(absolute);
  const components = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    try {
      await lstat(current);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw new Error('unsafe diagnostic output directory');
      await mkdir(current, { mode: 0o700 });
    }
    if (!(await validateOutputAncestors(absolute, outputRoot))) {
      throw new Error('unsafe diagnostic output directory');
    }
  }
  const metadata = await lstat(absolute);
  if (!isPrivateDirectory(metadata, currentUid())) throw new Error('unsafe diagnostic output directory');
  return absolute;
}

async function validateOutputRoot(request) {
  if (currentUid() === undefined) return { status: 'unsupported-owner-check' };
  if (!isAbsolute(request.outputDirectory)) return { status: 'unsafe' };
  if (!Array.isArray(request.disposableRoots) || request.disposableRoots.length === 0) {
    return { status: 'fixture-roots-unavailable' };
  }
  const lexicalOutput = resolve(request.outputDirectory);
  const candidate = await canonicalDirectory(lexicalOutput);
  if (!['captured', 'missing-parent'].includes(candidate.status)) return { status: 'unsafe' };
  const cachedRoots = new Map();
  for (const item of request.disposableCanonicalRoots ?? []) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof item.lexical !== 'string' ||
      typeof item.canonical !== 'string' ||
      resolve(item.lexical) !== item.lexical ||
      !isAbsolute(item.canonical) ||
      resolve(item.canonical) !== item.canonical
    ) {
      return { status: 'unsafe-fixture-root' };
    }
    const existing = cachedRoots.get(item.lexical);
    if (existing !== undefined && existing !== item.canonical) {
      return { status: 'unsafe-fixture-root' };
    }
    cachedRoots.set(item.lexical, item.canonical);
  }
  const lexicalDisposables = [...new Set(request.disposableRoots.map((path) => resolve(path)))];
  const disposableRecords = [];
  const canonicalDisposableRoots = [];
  for (const lexicalDisposable of lexicalDisposables) {
    if (isInside(lexicalOutput, lexicalDisposable) || isInside(lexicalDisposable, lexicalOutput)) {
      return { status: 'overlaps-fixture' };
    }
    const canonicalDisposable = await canonicalDirectory(lexicalDisposable);
    if (!['captured', 'missing-parent'].includes(canonicalDisposable.status)) {
      return { status: 'unsafe-fixture-root' };
    }
    const cachedPath = cachedRoots.get(lexicalDisposable);
    if (
      canonicalDisposable.status === 'captured' &&
      cachedPath !== undefined &&
      canonicalDisposable.canonical !== cachedPath
    ) {
      return { status: 'unsafe-fixture-root' };
    }
    disposableRecords.push({
      lexical: lexicalDisposable,
      status: canonicalDisposable.status,
      canonical: canonicalDisposable.canonical,
      cached: cachedPath,
    });
    if (canonicalDisposable.status === 'captured') {
      canonicalDisposableRoots.push({
        lexical: lexicalDisposable,
        canonical: canonicalDisposable.canonical,
      });
    }
  }
  for (const disposable of disposableRecords) {
    if (disposable.status === 'captured') {
      disposable.canonicalPath = disposable.canonical;
      continue;
    }
    if (disposable.cached !== undefined) {
      if (
        request.operation !== 'summary' ||
        disposable.canonical !== disposable.cached
      ) {
        return { status: 'unsafe-fixture-root' };
      }
      disposable.canonicalPath = disposable.cached;
      continue;
    }
    const ancestor = disposableRecords.find((candidateRoot) => {
      if (
        candidateRoot.status === 'unsafe' ||
        candidateRoot.lexical === disposable.lexical ||
        !isInside(candidateRoot.lexical, disposable.lexical)
      ) {
        return false;
      }
      const ancestorPath = candidateRoot.status === 'captured'
        ? candidateRoot.canonical
        : request.operation === 'summary' && candidateRoot.cached === candidateRoot.canonical
          ? candidateRoot.cached
          : undefined;
      if (ancestorPath === undefined) return false;
      const expected = resolve(
        ancestorPath,
        relative(candidateRoot.lexical, disposable.lexical),
      );
      return expected !== ancestorPath &&
        expected === disposable.canonical &&
        isInside(ancestorPath, expected);
    });
    if (!ancestor) return { status: 'unsafe-fixture-root' };
    const ancestorPath = ancestor.status === 'captured' ? ancestor.canonical : ancestor.cached;
    disposable.canonicalPath = resolve(
      ancestorPath,
      relative(ancestor.lexical, disposable.lexical),
    );
  }
  for (const disposable of disposableRecords) {
    if (
      isInside(candidate.canonical, disposable.canonicalPath) ||
      isInside(disposable.canonicalPath, candidate.canonical)
    ) {
      return { status: 'overlaps-fixture' };
    }
  }
  let outputDirectory;
  try { outputDirectory = await ensureDirectory(candidate.canonical, candidate.canonical); }
  catch { return { status: 'unsafe' }; }
  const verified = await canonicalDirectory(outputDirectory);
  return verified.status === 'captured' && verified.canonical === outputDirectory &&
    await validateOutputAncestors(outputDirectory, outputDirectory)
    ? { status: 'captured', outputDirectory, canonicalDisposableRoots }
    : { status: 'unsafe' };
}

async function inventoryOutput(path) {
  const files = new Map();
  const uid = currentUid();
  let bytes = 0;
  let entriesSeen = 0;
  let complete = true;
  let unsafe = false;
  let limitExceeded = false;
  let temporaryFiles = 0;
  if (uid === undefined) return { files, bytes, entriesSeen, complete: false, unsafe: true, limitExceeded: false, temporaryFiles };
  try {
    if (!isPrivateDirectory(await lstat(path), uid)) {
      return { files, bytes, entriesSeen, complete: false, unsafe: true, limitExceeded: false, temporaryFiles };
    }
  } catch {
    return { files, bytes, entriesSeen, complete: false, unsafe: true, limitExceeded: false, temporaryFiles };
  }
  const visit = async (directory, depth) => {
    if (depth > 8) {
      complete = false;
      limitExceeded = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      complete = false;
      unsafe = true;
      return;
    }
    for (const entry of entries) {
      if (limitExceeded || unsafe) return;
      entriesSeen += 1;
      if (entriesSeen > 512) {
        complete = false;
        limitExceeded = true;
        return;
      }
      const child = join(directory, entry.name);
      let metadata;
      try {
        metadata = await lstat(child);
      } catch {
        complete = false;
        unsafe = true;
        continue;
      }
      if (metadata.isSymbolicLink()) {
        complete = false;
        unsafe = true;
      } else if (metadata.isDirectory()) {
        if (!isPrivateDirectory(metadata, uid)) {
          complete = false;
          unsafe = true;
          continue;
        }
        await visit(child, depth + 1);
      } else if (metadata.isFile()) {
        if (!isPrivateRegularFile(metadata, uid)) {
          complete = false;
          unsafe = true;
          continue;
        }
        const size = Number(metadata.size);
        if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(bytes + size)) {
          complete = false;
          unsafe = true;
          return;
        }
        bytes += size;
        files.set(relative(path, child), size);
        if (entry.name.endsWith('.tmp')) {
          temporaryFiles += 1;
          complete = false;
        }
      } else {
        complete = false;
        unsafe = true;
      }
    }
  };
  await visit(path, 0);
  return { files, bytes, entriesSeen, complete, unsafe, limitExceeded, temporaryFiles };
}

function omission(state, key, reason, size, details = {}) {
  state.complete = false;
  const item = {
    invocationId: details.invocationId ?? 'snapshot',
    ...(details.contextId ? { contextId: details.contextId } : {}),
    ...(details.candidateId ? { candidateId: details.candidateId } : {}),
    artifact: key,
    reason,
    required: details.required !== false,
    ...(Number.isFinite(size) ? { knownBytes: size } : {}),
  };
  if (state.omissions.length < 100) state.omissions.push(item);
  else state.omissionOverflow += 1;
}

async function atomicWrite(path, bytes, outputRoot) {
  await ensureDirectory(dirname(path), outputRoot);
  const temporary = path + '.' + process.pid + '.tmp';
  let handle;
  let createdIdentity;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      String(before.uid) !== String(currentUid()) ||
      (before.mode & 0o7777n) !== 0o600n ||
      before.nlink !== 1n
    ) {
      throw new Error('unsafe diagnostic temporary file');
    }
    createdIdentity = { dev: String(before.dev), ino: String(before.ino) };
    await handle.writeFile(bytes);
    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile() ||
      String(after.dev) !== createdIdentity.dev ||
      String(after.ino) !== createdIdentity.ino ||
      String(after.uid) !== String(currentUid()) ||
      (after.mode & 0o7777n) !== 0o600n ||
      after.nlink !== 1n
    ) {
      throw new Error('diagnostic temporary file identity changed');
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const final = await lstat(path);
    if (
      !isPrivateRegularFile(final, currentUid()) ||
      String(final.dev) !== createdIdentity.dev ||
      String(final.ino) !== createdIdentity.ino
    ) {
      throw new Error('unsafe finalized diagnostic file');
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (createdIdentity) {
      const leftover = await lstat(temporary).catch(() => undefined);
      if (
        leftover &&
        String(leftover.dev) === createdIdentity.dev &&
        String(leftover.ino) === createdIdentity.ino
      ) {
        await unlink(temporary).catch(() => undefined);
      }
    }
    throw error;
  }
}

function outputWriter(request, state, reserved = false, existingOutput) {
  const root = request.outputDirectory;
  const operationLimit = reserved ? BUNDLE_LIMIT : BUNDLE_LIMIT - SUMMARY_RESERVE;
  const initialBytes = existingOutput.bytes;
  const fileSizes = new Map(existingOutput.files);
  let diskBytes = initialBytes;
  let netBytesAdded = 0;
  const write = async (key, value, format, roots = [], details = {}) => {
    const normalized = key.split('/');
    if (normalized.some((part) => !/^[a-zA-Z0-9._-]+$/u.test(part) || part === '.' || part === '..')) throw new Error('invalid diagnostic artifact key');
    let bytes = Buffer.from(value, 'utf8');
    if (format === 'text' && bytes.length > FILE_LIMIT) {
      bytes = bytes.subarray(bytes.length - FILE_LIMIT);
      value = bytes.toString('utf8');
      omission(state, key, 'truncated-text', bytes.length, { invocationId: request.label, ...details });
    }
    if (format === 'text') {
      value = redact(value, roots);
      bytes = Buffer.from(value, 'utf8');
    }
    if (bytes.length > FILE_LIMIT) { omission(state, key, format === 'json' ? 'oversized-json' : 'redaction-exceeded-file-bound', bytes.length, { invocationId: request.label, ...details }); return false; }
    const fileKey = normalized.join(sep);
    if (diskBytes + bytes.length > operationLimit) { omission(state, key, 'omitted-budget', bytes.length, { invocationId: request.label, ...details }); return false; }
    const previousSize = fileSizes.get(fileKey) ?? 0;
    const path = join(root, ...normalized);
    let current = root;
    await ensureDirectory(root, root);
    for (const part of normalized.slice(0, -1)) {
      current = join(current, part);
      await ensureDirectory(current, root);
    }
    await atomicWrite(path, bytes, root);
    diskBytes += bytes.length - previousSize;
    netBytesAdded = diskBytes - initialBytes;
    fileSizes.set(fileKey, bytes.length);
    return true;
  };
  return {
    writeJson: (key, data, details) => write(key, JSON.stringify(data, null, 2) + '\n', 'json', [], details),
    writeText: (key, value, roots, details) => write(key, value, 'text', roots, details),
    bytes: () => netBytesAdded,
    diskBytes: () => diskBytes,
  };
}

async function loadModules(paths) {
  const [configuration, layout, lifecycleStore, lifecycleDocument, activationRecord, controlProtocol, controlDiscovery] = await Promise.all([
    import(paths.configuration), import(paths.layout), import(paths.lifecycleStore), import(paths.lifecycleDocument), import(paths.activationRecord), import(paths.controlProtocol), import(paths.controlDiscovery),
  ]);
  return { ConfigurationResolver: configuration.ConfigurationResolver, resolveRevoLayout: layout.resolveRevoLayout, serverLifecyclePath: lifecycleStore.serverLifecyclePath, parseLifecycleDocument: lifecycleDocument.parseLifecycleDocument, parseActivationRecord: activationRecord.parseActivationRecord, parseControlRecord: controlProtocol.parseControlRecord, controlFile: controlDiscovery.CONTROL_FILE, controlRecordLimit: controlDiscovery.MAX_CONTROL_METADATA_BYTES };
}

async function resolveConfiguration(context, modules) {
  const env = context.configurationEnvironment;
  const layout = modules.resolveRevoLayout({ channel: context.channel, env, homeDir: context.homeDir, platform: context.platform });
  const configPath = env.REVO_CONFIG || join(layout.configDir, 'config.json');
  const roots = rootPaths(context);
  const configTrust = env.REVO_CONFIG
    ? await trustedCanonicalPath(configPath, roots)
    : await canonicalDirectory(dirname(configPath));
  const configTrustStatuses = env.REVO_CONFIG ? ['ok', 'missing-parent'] : ['captured', 'missing-parent'];
  if (!configTrustStatuses.includes(configTrust.status)) return { status: 'unapproved-path', roots };
  let configHasLogDir = false;
  const fileLoader = { read: async (path, explicit) => {
    if (path !== configPath) throw new Error('unapproved configuration path');
    const read = await readChecked(path, [configPath]);
    if (read.status === 'missing' && !explicit) return undefined;
    if (read.status !== 'captured') throw new Error('diagnostic configuration is ' + read.status);
    try {
      const parsed = JSON.parse(read.text);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        configHasLogDir = Object.hasOwn(parsed, 'logDir');
      }
      return parsed;
    } catch { throw new Error('diagnostic configuration is invalid'); }
  } };
  try {
    const resolved = await new modules.ConfigurationResolver(fileLoader).resolve({ env, flags: {}, homeDir: context.homeDir, packageVersion: context.packageVersion, platform: context.platform, wrapperChannel: context.channel });
    const logDirSource = env.REVO_LOG_DIR !== undefined
      ? 'environment'
      : configHasLogDir ? 'config-file' : 'default';
    return { status: 'captured', resolved, roots, configPath, logDirSource };
  } catch { return { status: 'invalid', roots, configPath }; }
}

async function captureActivation(context, modules) {
  const roots = rootPaths(context);
  const root = await safeDirectory(context.channelRoot, roots);
  if (root.status === 'missing') return { status: 'absent' };
  if (root.status !== 'captured') return { status: root.status };
  const currentPath = join(context.channelRoot, 'current');
  let pointerInfo;
  let pointer;
  try {
    pointerInfo = await lstat(currentPath);
    if (
      !pointerInfo.isSymbolicLink() ||
      pointerInfo.nlink !== 1 ||
      (typeof process.getuid === 'function' && pointerInfo.uid !== process.getuid())
    ) return { status: 'unsafe' };
    pointer = await readlink(currentPath);
  } catch (error) {
    return { status: errorCode(error) === 'ENOENT' ? 'absent' : 'unavailable' };
  }
  const match = /^activations\/([a-f0-9]{64})$/u.exec(pointer);
  if (!match?.[1]) return { status: 'invalid' };
  const manifest = join(context.channelRoot, 'activations', match[1], 'activation.json');
  const read = await readChecked(manifest, [manifest], 16 * 1024, false, true);
  if (read.status !== 'captured') return { status: read.status };
  if (!read.ownedPrivate) return { status: 'unsafe' };
  try {
    const record = modules.parseActivationRecord(JSON.parse(read.text));
    const after = await lstat(currentPath);
    const pointerAfter = await readlink(currentPath);
    if (
      !after.isSymbolicLink() ||
      (typeof process.getuid === 'function' && after.uid !== process.getuid()) ||
      String(after.dev) !== String(pointerInfo.dev) ||
      String(after.ino) !== String(pointerInfo.ino) ||
      pointerAfter !== pointer ||
      record.generationId !== match[1] ||
      record.channel !== context.channel ||
      record.target.platform !== context.platform ||
      record.target.arch !== context.targetArchitecture
    ) {
      return { status: 'unstable' };
    }
    return {
      status: 'valid',
      generationId: record.generationId,
      releaseVersion: record.release.version,
      target: { platform: context.platform, arch: context.targetArchitecture },
    };
  } catch {
    return { status: 'invalid' };
  }
}

async function captureControlRecord(context, config, modules) {
  if (config.status !== 'captured') return { status: 'unavailable' };
  const data = await trustedCanonicalPath(config.resolved.layout.dataDir, config.roots);
  if (data.status === 'missing-parent') return { status: 'missing' };
  if (data.status !== 'ok') return { status: 'unapproved-path' };
  const path = join(data.canonical, modules.controlFile);
  const read = await readChecked(path, [path], modules.controlRecordLimit, false, true);
  if (read.status === 'missing') return { status: 'missing' };
  if (read.status !== 'captured') return { status: read.status };
  if (!read.ownedPrivate) return { status: 'unsafe' };
  try {
    const record = modules.parseControlRecord(JSON.parse(read.text));
    if (!record || record.canonicalDataDir !== data.canonical) return { status: 'invalid' };
    return { status: 'valid-record' };
  } catch {
    return { status: 'invalid' };
  }
}

async function captureLifecycle(context, expectation, modules) {
  const absence = () => {
    if (expectation?.expectation === 'absent-permitted') {
      return { status: 'expected-absent', complete: true, reason: expectation.reason };
    }
    return {
      status: 'missing-unexpected',
      complete: false,
      reason: expectation?.expectation === 'unknown' ? 'phase-unknown' : expectation?.reason ?? 'required-lifecycle-missing',
    };
  };
  const config = await resolveConfiguration(context, modules);
  if (config.status !== 'captured') return { status: config.status, complete: false };
  const data = await trustedCanonicalPath(config.resolved.layout.dataDir, config.roots);
  if (!['ok', 'missing-parent'].includes(data.status)) return { status: 'unapproved-path', complete: false, logDirSource: config.logDirSource };
  if (data.status !== 'ok') return { status: 'missing-data-dir', complete: false, logDirSource: config.logDirSource };
  let log;
  if (config.logDirSource === 'environment' || config.logDirSource === 'config-file') {
    const lexicalLogDir = resolve(config.resolved.logDir);
    if (!config.roots.some((root) => isInside(root, lexicalLogDir))) {
      return { status: 'unapproved-path', complete: false, logDirSource: config.logDirSource };
    }
    log = await trustedCanonicalPath(config.resolved.logDir, config.roots);
  } else {
    const expectedDefaultLogDir = join(config.resolved.layout.stateDir, 'logs');
    if (resolve(config.resolved.logDir) !== resolve(expectedDefaultLogDir)) {
      return { status: 'unapproved-path', complete: false, logDirSource: config.logDirSource };
    }
    log = await canonicalDirectory(expectedDefaultLogDir);
  }
  const logTrustStatuses = config.logDirSource === 'environment' || config.logDirSource === 'config-file'
    ? ['ok', 'missing-parent']
    : ['captured', 'missing-parent'];
  if (!logTrustStatuses.includes(log.status)) return { status: 'unapproved-path', complete: false, logDirSource: config.logDirSource };
  const canonicalDataDir = data.canonical;
  const sourcePath = modules.serverLifecyclePath({ logDir: log.canonical, canonicalDataDir, channel: context.channel });
  const read = await readChecked(sourcePath, [sourcePath], FILE_LIMIT);
  if (read.status === 'missing') return { ...absence(), sourcePath, logDirSource: config.logDirSource };
  if (read.status !== 'captured') return { status: read.status, complete: false, logDirSource: config.logDirSource };
  try {
    const document = modules.parseLifecycleDocument(JSON.parse(read.text));
    if (!document) return { status: 'invalid', complete: false, sourcePath, logDirSource: config.logDirSource };
    const text = document.events.map((event) => JSON.stringify({ sequence: event.sequence, time: event.time, phase: event.phase, state: event.state, code: event.code })).join('\n') + (document.events.length ? '\n' : '');
    return { status: 'captured', complete: true, text, eventCount: document.events.length, sourcePath, logDirSource: config.logDirSource };
  } catch { return { status: 'invalid', complete: false, sourcePath, logDirSource: config.logDirSource }; }
}

async function inventoryAttempts(context, allowMissingRoot = false, includeContents = false) {
  const roots = rootPaths(context);
  const directory = await safeDirectory(context.channelRoot, roots);
  if (directory.status === 'missing') {
    return {
      inventory: {
        status: allowMissingRoot ? 'captured' : 'missing-unexpected',
        rootStatus: allowMissingRoot ? 'expected-absent-before-initial' : 'missing-unexpected',
        attempts: [],
        complete: allowMissingRoot,
      },
      evidence: new Map(),
    };
  }
  if (directory.status !== 'captured') {
    return { inventory: { status: directory.status, attempts: [], complete: false }, evidence: new Map() };
  }
  let entries;
  try { entries = await readdir(context.channelRoot, { withFileTypes: true }); }
  catch (error) {
    if (errorCode(error) === 'ENOENT' && allowMissingRoot) {
      return { inventory: { status: 'captured', rootStatus: 'expected-absent-before-initial', attempts: [], complete: true }, evidence: new Map() };
    }
    return { inventory: { status: errorCode(error) === 'ENOENT' ? 'missing-unexpected' : 'io-error', attempts: [], complete: false }, evidence: new Map() };
  }
  const names = entries.filter((entry) => entry.name.startsWith('.attempt.')).map((entry) => entry.name).sort();
  let complete = names.length <= 32;
  const attempts = [];
  const evidence = new Map();
  for (const name of names.slice(0, 32)) {
    const path = join(context.channelRoot, name);
    try {
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        attempts.push({ name, status: 'unsafe' });
        complete = false;
        continue;
      }
      const scratchPath = join(path, 'runtime', 'scratch');
      let scratch = 'missing';
      const scratchPathTrust = await canonicalDirectory(scratchPath);
      if (scratchPathTrust.status === 'captured') {
        try {
          const scratchInfo = await lstat(scratchPath);
          scratch = scratchInfo.isDirectory() && !scratchInfo.isSymbolicLink() ? 'present' : 'unsafe';
        } catch (error) {
          scratch = errorCode(error) === 'ENOENT' ? 'missing' : 'io-error';
        }
      } else if (scratchPathTrust.status === 'unsafe') {
        scratch = 'unsafe';
      }
      if (scratch === 'unsafe' || scratch === 'io-error') complete = false;
      const logs = {};
      const contents = {};
      for (const logName of ['server-start.log', 'install-session.log']) {
        if (scratch !== 'present') {
          logs[logName] = { status: scratch === 'missing' ? 'missing' : scratch };
          continue;
        }
        const logPath = join(scratchPath, logName);
        const log = await readChecked(logPath, [logPath], FILE_LIMIT, true);
        logs[logName] = {
          status: log.status,
          ...(log.facts ? { ...log.facts, boundedDigest: log.digest } : {}),
          ...(typeof log.size === 'number' ? { size: log.size } : {}),
        };
        if (includeContents && log.status === 'captured') contents[logName] = log.text;
        if (['unsafe', 'unapproved-path', 'io-error', 'too-large'].includes(log.status)) complete = false;
      }
      attempts.push({ name, dev: String(metadata.dev), ino: String(metadata.ino), scratch, logs });
      if (includeContents) evidence.set(name, contents);
    } catch {
      attempts.push({ name, status: 'io-error' });
      complete = false;
    }
  }
  return { inventory: { status: 'captured', attempts, complete }, evidence };
}

async function inspectNode(context) {
  const roots = redactionRoots(context);
  const record = await readChecked(context.pnpmNodeRecord, [context.pnpmNodeRecord]);
  const actualPath = record.status === 'captured' ? record.text.trim() : undefined;
  const expectedPath = join(
    context.installRoot,
    context.channel,
    'node',
    context.nodeVersion,
    context.platform + '-' + context.targetArchitecture,
    'bin',
    'node',
  );
  const inspect = async (candidate) => {
    if (!candidate || !isAbsolute(candidate)) return { status: candidate ? 'invalid-path' : record.status };
    const trusted = await trustedCanonicalPath(candidate, [context.installRoot]);
    if (!['ok', 'missing-parent'].includes(trusted.status)) return { status: 'unapproved-path' };
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return { status: 'unsafe' };
      const canonical = await realpath(candidate);
      if (!isInside(trusted.canonicalRoot, canonical)) return { status: 'unsafe' };
      return {
        status: 'captured',
        realpath: redact(canonical, roots),
        mode: (metadata.mode & 0o777).toString(8),
      };
    } catch (error) { return { status: errorCode(error) === 'ENOENT' ? 'missing' : 'io-error' }; }
  };
  return {
    source: record.status === 'captured' ? 'REVO_PNPM_NODE_RECORD' : 'expected-path-only',
    recordedPath: actualPath ? redact(actualPath, roots) : undefined,
    recorded: await inspect(actualPath),
    expectedPath: redact(expectedPath, roots),
    expected: await inspect(expectedPath),
  };
}

function attemptChanged(before, after) {
  if (!before || !after || before.status || after.status) return false;
  if (before.dev !== after.dev || before.ino !== after.ino || before.scratch !== after.scratch) return true;
  for (const name of ['server-start.log', 'install-session.log']) {
    const previous = before.logs?.[name] ?? {};
    const current = after.logs?.[name] ?? {};
    for (const key of ['status', 'dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'boundedDigest']) {
      if (previous[key] !== current[key]) return true;
    }
  }
  return false;
}

function expectedLifecycleFor(request, context, index) {
  return request.lifecycleExpectations?.find((item) => item.root === context.root) ?? {
    root: context.root,
    expectation: 'unknown',
    reason: 'phase-not-provided',
    contextId: context.contextId ?? 'context-' + index,
  };
}

function recordRequiredFailure(state, request, context, artifact, reason, candidateId) {
  omission(state, artifact, reason, undefined, {
    invocationId: request.label,
    contextId: context.contextId,
    candidateId,
    required: true,
  });
}

async function run(request) {
  const state = { complete: true, omissions: [], omissionOverflow: 0, issues: [] };
  const outputValidation = await validateOutputRoot(request);
  if (outputValidation.status !== 'captured') {
    omission(state, 'diagnostic-output-root', outputValidation.status);
    return { result: {}, complete: false, issues: ['diagnostic output root rejected'], omissions: state.omissions, omissionOverflow: 0, bytesWritten: 0 };
  }
  request.outputDirectory = outputValidation.outputDirectory;
  const existingOutput = await inventoryOutput(request.outputDirectory);
  if (existingOutput.unsafe || existingOutput.limitExceeded) {
    omission(state, 'diagnostic-output-tree', existingOutput.unsafe ? 'unsafe-entry' : 'tree-limit-exceeded');
    return { result: {}, complete: false, issues: ['diagnostic output tree rejected'], omissions: state.omissions, omissionOverflow: 0, bytesWritten: 0, canonicalDisposableRoots: outputValidation.canonicalDisposableRoots };
  }
  if (!existingOutput.complete) {
    state.complete = false;
    omission(state, 'diagnostic-output-tree', 'stale-temporary-file', existingOutput.bytes, { required: true });
  }
  const parentBytes = request.usedBytes;
  if (!Number.isSafeInteger(parentBytes) || parentBytes < 0) {
    state.complete = false;
    omission(state, 'diagnostic-output-budget', 'invalid-parent-byte-counter');
    return {
      result: {},
      complete: false,
      issues: ['invalid parent output byte counter'],
      omissions: state.omissions,
      omissionOverflow: 0,
      bytesWritten: 0,
      diskBytesAfter: existingOutput.bytes,
      canonicalDisposableRoots: outputValidation.canonicalDisposableRoots,
    };
  }
  if (parentBytes > existingOutput.bytes) {
    state.complete = false;
    state.issues.push('parent-output-byte-counter-exceeds-disk');
  }
  if (existingOutput.bytes > BUNDLE_LIMIT) {
    omission(state, 'diagnostic-output-tree', 'bundle-limit-exceeded', existingOutput.bytes);
    return { result: {}, complete: false, issues: ['diagnostic output bundle exceeds its bound'], omissions: state.omissions, omissionOverflow: 0, bytesWritten: 0, diskBytesAfter: existingOutput.bytes, canonicalDisposableRoots: outputValidation.canonicalDisposableRoots };
  }
  request.remainingBytes = Math.max(0, BUNDLE_LIMIT - existingOutput.bytes);
  const writer = outputWriter(request, state, request.operation === 'summary', existingOutput);
  const modules = await loadModules(request.modulePaths);
  const result = {};
  if (request.operation === 'prepare') {
    result.inventories = [];
    for (let index = 0; index < request.fixtures.length; index += 1) {
      const context = {
        ...request.fixtures[index],
        contextId: request.fixtures[index].contextId ?? 'context-' + index,
      };
      const prepared = await inventoryAttempts(context, request.label === 'initial');
      const inventory = prepared.inventory;
      if (!inventory.complete) {
        state.complete = false;
        recordRequiredFailure(state, request, context, 'attempt-inventory', inventory.status, undefined);
      }
      result.inventories.push({ root: context.root, contextId: context.contextId, inventory });
    }
    const persistedInventories = result.inventories.map(({ contextId, inventory }) => ({
      contextId,
      inventory,
    }));
    if (!(await writer.writeJson('attempts/' + request.label + '/preparation.json', { label: request.label, inventories: persistedInventories }))) {
      state.complete = false;
    }
  } else if (request.operation === 'snapshot') {
    const fixtures = [];
    const lifecycleResults = [];
    for (let index = 0; index < request.fixtures.length; index += 1) {
      const context = {
        ...request.fixtures[index],
        contextId: request.fixtures[index].contextId ?? 'context-' + index,
      };
      const roots = redactionRoots(context);
      const activation = await captureActivation(context, modules);
      const config = await resolveConfiguration(context, modules);
      const controlRecord = await captureControlRecord(context, config, modules);
      const expectation = expectedLifecycleFor(request, context, index);
      const lifecycle = await captureLifecycle(context, expectation, modules);
      const inspectedInventory = await inventoryAttempts(context);
      const inventory = inspectedInventory.inventory;
      if (config.status !== 'captured') {
        state.complete = false;
        recordRequiredFailure(state, request, context, 'configuration', config.status, undefined);
      }
      if (!lifecycle.complete) {
        state.complete = false;
        recordRequiredFailure(state, request, context, 'server-lifecycle', lifecycle.status, undefined);
      }
      if (!inventory.complete) {
        state.complete = false;
        recordRequiredFailure(state, request, context, 'attempt-inventory', inventory.status, undefined);
      }
      if (lifecycle.text && !(await writer.writeText('snapshots/' + request.label + '/' + context.contextId + '.lifecycle.jsonl', lifecycle.text, roots, { invocationId: request.label, contextId: context.contextId }))) {
        state.complete = false;
      }
      lifecycleResults.push({ lifecycle, expectation, context });
      if (controlRecord.status !== 'valid-record' && controlRecord.status !== 'missing') {
        recordRequiredFailure(state, request, context, 'control-record', controlRecord.status, undefined);
      }
      recordRequiredFailure(
        state,
        request,
        context,
        'server-status',
        'active-status-not-queried-in-isolated-collector',
        undefined,
      );
      fixtures.push({ contextId: context.contextId, channel: context.channel, port: context.port, platform: context.platform, arch: context.targetArchitecture, osRelease: request.osRelease, activation, serverStatus: { kind: 'unavailable', reason: 'active-status-not-queried-in-isolated-collector' }, controlRecord, lifecycle: {}, attemptInventory: inventory });
    }
    const lifecycleGroups = new Map();
    for (const item of lifecycleResults) {
      if (!item.lifecycle.sourcePath) continue;
      const group = lifecycleGroups.get(item.lifecycle.sourcePath) ?? [];
      group.push(item);
      lifecycleGroups.set(item.lifecycle.sourcePath, group);
    }
    for (const group of lifecycleGroups.values()) {
      if (group.length > 1 && group.some((item) => item.expectation.expectation === 'required')) {
        for (const item of group) {
          if (item.lifecycle.status === 'expected-absent') {
            item.lifecycle.status = 'missing-unexpected';
            item.lifecycle.complete = false;
            item.lifecycle.reason = 'shared-lifecycle-location-required-by-another-context';
            state.complete = false;
            recordRequiredFailure(state, request, item.context, 'server-lifecycle', item.lifecycle.reason, undefined);
          }
        }
      }
    }
    for (let index = 0; index < lifecycleResults.length; index += 1) {
      const item = lifecycleResults[index];
      const matching = item.lifecycle.sourcePath ? lifecycleGroups.get(item.lifecycle.sourcePath) ?? [] : [];
      fixtures[index].lifecycle = {
        status: item.lifecycle.status,
        eventCount: item.lifecycle.eventCount,
        logDirSource: item.lifecycle.logDirSource,
        expectation: item.expectation.expectation,
        expectationReason: item.expectation.reason,
        ...(item.lifecycle.reason ? { reason: item.lifecycle.reason } : {}),
        ...(matching.length > 1 ? { sharedLocationContexts: matching.length } : {}),
      };
    }
    if (!(await writer.writeJson('snapshots/' + request.label + '.json', { label: request.label, capturedAt: new Date().toISOString(), fixtures }))) {
      state.complete = false;
    }
  } else if (request.operation === 'result') {
    const context = {
      ...request.context,
      contextId: request.context.contextId ?? 'context-0',
    };
    const roots = redactionRoots(context);
    const lifecycle = await captureLifecycle(context, request.lifecycleExpectation, modules);
    const inspectedAfter = await inventoryAttempts(context, false, true);
    const after = inspectedAfter.inventory;
    const before = request.beforeInventory;
    const beforeByName = new Map((before?.attempts ?? []).filter((item) => item.name && item.dev && item.ino && !item.status).map((item) => [item.name, item]));
    const changed = after.attempts.filter((item) => item.name && !item.status && (!beforeByName.has(item.name) || attemptChanged(beforeByName.get(item.name), item)));
    const inventoriesComplete = before?.complete === true && before.status === 'captured' && after.complete && after.status === 'captured';
    let association = 'unresolved';
    if (!before) association = 'unresolved';
    else if (!inventoriesComplete) association = 'incomplete';
    else if (changed.length === 1) association = 'unique-observed-candidate';
    else if (changed.length > 1) association = 'ambiguous';
    else if (request.code === 0 && request.signal === null && changed.length === 0 && inventoriesComplete) association = 'not-retained-after-success';
    if (association === 'ambiguous' || association === 'unresolved' || association === 'incomplete') {
      recordRequiredFailure(state, request, context, 'attempt-association', association, undefined);
    }
    const stdoutWritten = await writer.writeText('attempts/' + request.label + '/stdout.tail.txt', request.stdout, roots, { invocationId: request.label, contextId: context.contextId });
    const stderrWritten = await writer.writeText('attempts/' + request.label + '/stderr.tail.txt', request.stderr, roots, { invocationId: request.label, contextId: context.contextId });
    if (!stdoutWritten || !stderrWritten) state.complete = false;
    if (!lifecycle.complete) recordRequiredFailure(state, request, context, 'server-lifecycle', lifecycle.status, undefined);
    if (lifecycle.text && !(await writer.writeText('attempts/' + request.label + '/lifecycle.sanitized.jsonl', lifecycle.text, roots, { invocationId: request.label, contextId: context.contextId }))) state.complete = false;
    if (request.pipesIncomplete) recordRequiredFailure(state, request, context, 'installer-pipes', 'pipes-incomplete', undefined);
    const logFacts = [];
    const candidatesToCapture = changed.slice(0, 4);
    for (let index = 0; index < candidatesToCapture.length; index += 1) {
      const candidate = candidatesToCapture[index];
      const candidateId = 'candidate-' + index;
      const contents = inspectedAfter.evidence.get(candidate.name) ?? {};
      const logs = {};
      for (const logName of ['server-start.log', 'install-session.log']) {
        const observation = candidate.logs?.[logName] ?? { status: 'missing' };
        let status = observation.status;
        let reason;
        if (status === 'missing' && association === 'not-retained-after-success') {
          status = 'not-retained-after-success';
          reason = 'successful-installer-removed-attempt';
        } else if (status === 'missing' && request.label === 'cancel-before-commit' && logName === 'server-start.log') {
          status = 'expected-absent';
          reason = 'cancelled-before-commit-before-autostart';
        } else if (status === 'missing') {
          status = 'missing-unexpected';
          reason = request.lifecycleExpectation?.reason ?? 'required-log-missing';
        }
        logs[logName] = { status, ...(reason ? { reason } : {}), ...(observation.status === 'captured' ? { facts: observation } : {}) };
        if (observation.status === 'captured') {
          const outputName = logName === 'server-start.log' ? 'server-start.tail.txt' : 'install-session.tail.txt';
          if (!(await writer.writeText('attempts/' + request.label + '/candidates/' + candidateId + '/' + outputName, contents[logName], roots, { invocationId: request.label, contextId: context.contextId, candidateId }))) state.complete = false;
        } else if (status === 'missing-unexpected' || ['unsafe', 'io-error', 'too-large'].includes(status)) {
          recordRequiredFailure(state, request, context, logName, status, candidateId);
        }
      }
      const facts = { candidateId, observedName: candidate.name, basis: beforeByName.has(candidate.name) ? 'changed-directory-or-scratch-log-facts' : 'new-directory', association, logs };
      logFacts.push(facts);
      if (!(await writer.writeJson('attempts/' + request.label + '/candidates/' + candidateId + '/facts.json', facts, { invocationId: request.label, contextId: context.contextId, candidateId }))) state.complete = false;
    }
    if (changed.length > 4) {
      omission(state, 'attempts/' + request.label + '/candidates/*', 'omitted-candidate-limit', changed.length - 4, { invocationId: request.label, contextId: context.contextId });
    }
    const node = await inspectNode(context);
    if (node.expected.status !== 'captured') recordRequiredFailure(state, request, context, 'expected-node-runtime', node.expected.status, undefined);
    const snapshotComplete = state.complete && lifecycle.complete && inventoriesComplete && association !== 'ambiguous' && association !== 'unresolved' && association !== 'incomplete' && !request.pipesIncomplete && node.expected.status === 'captured';
    if (!snapshotComplete) state.complete = false;
    if (!(await writer.writeJson('attempts/' + request.label + '/result.json', { label: request.label, startedAt: request.startedAt, completedAt: new Date().toISOString(), exitCode: request.code, signal: request.signal, installerPid: request.installerPid, pipesIncomplete: request.pipesIncomplete, snapshotStatus: snapshotComplete ? 'complete' : 'incomplete', channel: context.channel, port: context.port, attemptAssociation: association, candidateCount: changed.length, candidates: logFacts, attemptInventoryStatus: after.status, lifecycle: { status: lifecycle.status, logDirSource: lifecycle.logDirSource, expectation: request.lifecycleExpectation?.expectation, expectationReason: request.lifecycleExpectation?.reason, eventCount: lifecycle.eventCount }, node }))) state.complete = false;
    result.inventory = after;
  } else if (request.operation === 'summary') {
    const omissions = [...request.omissions, ...state.omissions];
    if (request.omissionOverflow > 0) omissions.push({ artifact: '*', reason: 'additional-omissions-aggregated', count: request.omissionOverflow });
    const omissionsWritten = await writer.writeJson('omissions.json', { omissions });
    if (!omissionsWritten) {
      state.complete = false;
      state.issues.push('omissions-artifact-write-failed');
    }
    const summaryWritten = await writer.writeJson('summary.json', { schemaVersion: 'revo-intel-diagnostic/v1', testOutcome: request.testOutcome, collectorComplete: request.complete && state.complete && omissions.length === 0, collectorIssues: [...request.issues, ...state.issues].slice(0, 40), collectorBytes: writer.diskBytes(), cleanupOutcome: request.cleanupOutcome, capturedAt: new Date().toISOString() });
    if (!summaryWritten) state.complete = false;
  } else throw new Error('unsupported diagnostic operation');
  return { result, complete: state.complete, issues: state.issues, omissions: state.omissions, omissionOverflow: state.omissionOverflow, bytesWritten: writer.bytes(), diskBytesAfter: writer.diskBytes(), canonicalDisposableRoots: outputValidation.canonicalDisposableRoots };
}

process.on('message', (request) => {
  void run(request).then((result) => {
    process.send({ ok: true, result }, () => process.exit(0));
  }, () => {
    process.send({ ok: false, reason: 'collector-operation-failed' }, () => process.exit(1));
  });
});
`;

function intelModulePaths(): Record<string, string> {
  const dist = join(process.cwd(), 'dist');
  return {
    configuration: pathToFileURL(join(dist, 'configuration', 'configuration-resolver.js')).href,
    layout: pathToFileURL(join(dist, 'layout.js')).href,
    lifecycleStore: pathToFileURL(join(dist, 'server-logs', 'store.service.js')).href,
    lifecycleDocument: pathToFileURL(join(dist, 'server-logs', 'document.js')).href,
    activationRecord: pathToFileURL(join(dist, 'installation', 'activation-record.js')).href,
    controlProtocol: pathToFileURL(join(dist, 'processes', 'control-protocol.js')).href,
    controlDiscovery: pathToFileURL(join(dist, 'processes', 'control-discovery.service.js')).href,
  };
}

export function intelCollectorsQuiescent(): boolean {
  return intelCollectors.size === 0;
}

function applyIntelCollectorResult(
  response: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (response.ok !== true || !response.result || typeof response.result !== 'object') {
    return undefined;
  }
  const result = response.result as Record<string, unknown>;
  if (Array.isArray(result.canonicalDisposableRoots)) {
    for (const item of result.canonicalDisposableRoots) {
      if (
        typeof item === 'object' &&
        item !== null &&
        typeof item.lexical === 'string' &&
        typeof item.canonical === 'string'
      ) {
        intelCanonicalFixtureRoots.set(resolvePath(item.lexical), resolvePath(item.canonical));
      }
    }
  }
  const bytesWritten = result.bytesWritten;
  const nextBytes =
    typeof bytesWritten === 'number' ? intelCollectorState.bytes + bytesWritten : Number.NaN;
  if (!Number.isSafeInteger(bytesWritten) || !Number.isSafeInteger(nextBytes) || nextBytes < 0) {
    intelCollectorState.complete = false;
    intelCollectorState.issues.push('collector-net-byte-counter-invalid');
  } else {
    intelCollectorState.bytes = nextBytes;
  }
  if (result.complete !== true) {
    intelCollectorState.complete = false;
  }
  if (Array.isArray(result.issues)) {
    intelCollectorState.issues.push(
      ...result.issues.filter((item): item is string => typeof item === 'string'),
    );
  }
  if (Array.isArray(result.omissions)) {
    const records = result.omissions.filter(
      (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
    );
    for (const record of records) {
      if (intelCollectorState.omissions.length < 100) {
        intelCollectorState.omissions.push(record);
      } else {
        intelCollectorState.omissionOverflow += 1;
      }
    }
  }
  if (
    typeof result.omissionOverflow === 'number' &&
    Number.isInteger(result.omissionOverflow) &&
    result.omissionOverflow > 0
  ) {
    intelCollectorState.omissionOverflow += result.omissionOverflow;
  }
  return result;
}

async function runIntelCollector(
  operation: 'prepare' | 'snapshot' | 'result' | 'summary',
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const outputDirectory = intelDiagnosticsDirectory();
  if (!outputDirectory) {
    return undefined;
  }
  if (intelCollectors.size > 0) {
    throw new Error('a prior Intel collector has not exited');
  }
  const assignContextId = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    const context = value as Record<string, unknown>;
    if (typeof context.root !== 'string' || context.root.length === 0) {
      return value;
    }
    const lexicalRoot = resolvePath(context.root);
    let contextId = intelContextIds.get(lexicalRoot);
    if (contextId === undefined) {
      contextId = `context-${nextIntelContextId}`;
      nextIntelContextId += 1;
      intelContextIds.set(lexicalRoot, contextId);
    }
    return { ...context, contextId };
  };
  const assignedFixtures = Array.isArray(input.fixtures)
    ? input.fixtures.map(assignContextId)
    : undefined;
  const assignedContext =
    typeof input.context === 'object' && input.context !== null
      ? assignContextId(input.context)
      : undefined;
  const contexts = [
    ...(assignedFixtures ?? []),
    ...(assignedContext === undefined ? [] : [assignedContext]),
  ];
  for (const context of contexts) {
    if (typeof context !== 'object' || context === null) {
      continue;
    }
    for (const key of ['root', 'installRoot'] as const) {
      const value = (context as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.length > 0) {
        intelFixtureRoots.add(resolvePath(value));
      }
    }
  }
  const remainingBytes = Math.max(0, INTEL_BUNDLE_LIMIT - intelCollectorState.bytes);
  const request = {
    ...input,
    ...(assignedFixtures === undefined ? {} : { fixtures: assignedFixtures }),
    ...(assignedContext === undefined ? {} : { context: assignedContext }),
    operation,
    outputDirectory,
    remainingBytes:
      operation === 'summary' ? Math.min(remainingBytes, INTEL_SUMMARY_RESERVE) : remainingBytes,
    usedBytes: intelCollectorState.bytes,
    disposableRoots: [...intelFixtureRoots],
    disposableCanonicalRoots: [...intelCanonicalFixtureRoots].map(([lexical, canonical]) => ({
      lexical,
      canonical,
    })),
    modulePaths: intelModulePaths(),
    osRelease: osRelease(),
  };
  const child = spawn(process.execPath, ['--input-type=module', '--eval', INTEL_COLLECTOR_SOURCE], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C' },
  });
  intelCollectors.add(child);
  let message: Record<string, unknown> | undefined;
  let outputBytes = 0;
  let outputOverflow = false;
  let collectorSpawnConfirmed = false;
  const onCollectorOutput = (chunk: Buffer) => {
    outputBytes = Math.min(INTEL_FILE_LIMIT + 1, outputBytes + chunk.length);
    if (outputBytes > INTEL_FILE_LIMIT && !outputOverflow) {
      outputOverflow = true;
      intelCollectorState.complete = false;
      intelCollectorState.issues.push('collector process output exceeded its bound');
      if (collectorSpawnConfirmed) {
        try {
          child.kill('SIGKILL');
        } catch {
          // The deadline supervisor will report an unconfirmed stop if necessary.
        }
      }
    }
  };
  child.stdout?.on('data', onCollectorOutput);
  child.stderr?.on('data', onCollectorOutput);
  const outcome = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error?: Error;
    readonly spawnConfirmed: boolean;
    readonly exitConfirmed: boolean;
    readonly timedOut: boolean;
    readonly unconfirmed: boolean;
  }>((resolve) => {
    let settled = false;
    let spawnConfirmed = false;
    let exitConfirmed = false;
    let killSent = false;
    let processError: Error | undefined;
    let exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined;
    let messageGraceTimer: NodeJS.Timeout | undefined;
    const finish = (value: {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly error?: Error;
      readonly spawnConfirmed: boolean;
      readonly exitConfirmed: boolean;
      readonly timedOut: boolean;
      readonly unconfirmed: boolean;
    }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(deadlineTimer);
      if (messageGraceTimer) {
        clearTimeout(messageGraceTimer);
      }
      child.removeListener('message', onMessage);
      child.removeListener('spawn', onSpawn);
      if (exitConfirmed || !spawnConfirmed) {
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
      }
      resolve(value);
    };
    const killTimer = setTimeout(() => {
      if (spawnConfirmed && !exitConfirmed) {
        killSent = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // The five-second deadline remains authoritative.
        }
      }
    }, INTEL_COLLECTOR_KILL_AT);
    const deadlineTimer = setTimeout(() => {
      if (exitConfirmed && exit) {
        finish({
          ...exit,
          ...(processError !== undefined ? { error: processError } : {}),
          spawnConfirmed,
          exitConfirmed,
          timedOut: killSent,
          unconfirmed: false,
        });
      } else {
        finish({
          code: null,
          signal: null,
          ...(processError !== undefined ? { error: processError } : {}),
          spawnConfirmed,
          exitConfirmed,
          timedOut: true,
          unconfirmed: true,
        });
      }
    }, INTEL_COLLECTOR_DEADLINE);
    const onMessage = (value: unknown) => {
      if (settled || typeof value !== 'object' || value === null) {
        return;
      }
      try {
        if (Buffer.byteLength(JSON.stringify(value)) > INTEL_FILE_LIMIT) {
          return;
        }
      } catch {
        return;
      }
      message = value as Record<string, unknown>;
      if (exitConfirmed && exit) {
        finish({
          ...exit,
          ...(processError !== undefined ? { error: processError } : {}),
          spawnConfirmed,
          exitConfirmed,
          timedOut: killSent,
          unconfirmed: false,
        });
      }
    };
    const onError = (error: Error) => {
      processError ??= error;
      if (!spawnConfirmed && child.pid === undefined) {
        exitConfirmed = false;
        intelCollectors.delete(child);
        finish({
          code: null,
          signal: null,
          error,
          spawnConfirmed,
          exitConfirmed,
          timedOut: false,
          unconfirmed: false,
        });
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      exitConfirmed = true;
      exit = { code, signal };
      intelCollectors.delete(child);
      if (settled) {
        child.stdout?.removeListener('data', onCollectorOutput);
        child.stderr?.removeListener('data', onCollectorOutput);
        child.removeListener('error', onError);
        child.removeListener('message', onMessage);
        child.removeListener('exit', onExit);
        return;
      }
      if (message || code !== 0 || processError) {
        finish({
          code,
          signal,
          ...(processError !== undefined ? { error: processError } : {}),
          spawnConfirmed,
          exitConfirmed,
          timedOut: killSent,
          unconfirmed: false,
        });
      } else {
        messageGraceTimer = setTimeout(() => {
          finish({
            code,
            signal,
            spawnConfirmed,
            exitConfirmed,
            timedOut: killSent,
            unconfirmed: false,
          });
        }, 100);
      }
    };
    const onSpawn = () => {
      spawnConfirmed = true;
      collectorSpawnConfirmed = true;
      child.send(request, (error) => {
        if (error) {
          processError ??= error;
          if (exitConfirmed && exit) {
            finish({
              ...exit,
              error: processError,
              spawnConfirmed,
              exitConfirmed,
              timedOut: killSent,
              unconfirmed: false,
            });
          }
        }
      });
    };
    child.once('spawn', onSpawn);
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
  });
  if (outcome.exitConfirmed || !outcome.spawnConfirmed) {
    child.stdout?.removeListener('data', onCollectorOutput);
    child.stderr?.removeListener('data', onCollectorOutput);
  }
  if (outputBytes > INTEL_FILE_LIMIT && !outputOverflow) {
    intelCollectorState.complete = false;
    intelCollectorState.issues.push('collector process output exceeded its bound');
  }
  if (outcome.unconfirmed) {
    intelCollectorState.complete = false;
    intelCollectorState.issues.push('collector-stop-unconfirmed');
    throw new Error('Intel diagnostic collector stop was not confirmed');
  }
  if (outcome.timedOut) {
    intelCollectorState.complete = false;
    intelCollectorState.issues.push('collector-timeout');
    return undefined;
  }
  if (outcome.error || outcome.code !== 0 || !message) {
    intelCollectorState.complete = false;
    intelCollectorState.issues.push(
      outcome.spawnConfirmed ? 'collector-process-failed' : 'collector-spawn-failed',
    );
    return undefined;
  }
  const result = applyIntelCollectorResult(message);
  if (!result) {
    intelCollectorState.complete = false;
    intelCollectorState.issues.push('collector-result-invalid');
  }
  return result;
}

export async function prepareIntelInvocation(
  label: string,
  fixtures: readonly IntelFixtureContext[],
): Promise<void> {
  if (!intelDiagnosticsDirectory()) {
    return;
  }
  if (!/^[a-z0-9-]+$/u.test(label)) {
    throw new Error('invalid diagnostic invocation label');
  }
  const result = await runIntelCollector('prepare', { label, fixtures });
  if (
    !result ||
    !Array.isArray(result.result && (result.result as Record<string, unknown>).inventories)
  ) {
    return;
  }
  const inventories = (result.result as { inventories: { root: string; inventory: unknown }[] })
    .inventories;
  intelInvocationInventories.set(
    label,
    new Map(inventories.map((item) => [item.root, item.inventory])),
  );
}

export async function captureIntelSnapshot(
  label: string,
  fixtures: readonly IntelFixtureContext[],
  lifecycleExpectations: readonly IntelLifecycleExpectation[] = [],
): Promise<void> {
  if (!intelDiagnosticsDirectory()) {
    return;
  }
  if (!/^[a-z0-9-]+$/u.test(label)) {
    throw new Error('invalid diagnostic snapshot label');
  }
  await runIntelCollector('snapshot', { label, fixtures, lifecycleExpectations });
}

async function captureIntelInstallerResult(input: {
  readonly context: IntelFixtureContext;
  readonly label: string;
  readonly startedAt: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly installerPid: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly pipesIncomplete: boolean;
}): Promise<void> {
  if (!intelDiagnosticsDirectory()) {
    return;
  }
  const before = intelInvocationInventories.get(input.label)?.get(input.context.root);
  const lifecycleExpectation: IntelLifecycleExpectation = {
    root: input.context.root,
    expectation: input.label === 'cancel-before-commit' ? 'absent-permitted' : 'required',
    reason:
      input.label === 'cancel-before-commit'
        ? 'activation-cancelled-before-commit-and-autostart'
        : 'installer-invocation-is-expected-to-reach-server-start',
  };
  await runIntelCollector('result', { ...input, beforeInventory: before, lifecycleExpectation });
}

export async function writeIntelDiagnosticSummary(input: {
  readonly testOutcome: 'passed' | 'failed' | 'incomplete';
  readonly cleanupOutcome: Readonly<Record<string, string>>;
}): Promise<void> {
  if (!intelDiagnosticsDirectory()) {
    return;
  }
  if (!intelCollectorsQuiescent()) {
    throw new Error('cannot write diagnostic summary before collector exit');
  }
  await runIntelCollector('summary', {
    ...input,
    complete: intelCollectorState.complete,
    issues: intelCollectorState.issues,
    omissions: intelCollectorState.omissions,
    omissionOverflow: intelCollectorState.omissionOverflow,
  });
}

export function recordIntelCollectorIssue(error: unknown, roots: readonly string[] = []): void {
  intelCollectorState.complete = false;
  const message = error instanceof Error ? error.message : String(error);
  intelCollectorState.issues.push(redactDiagnosticText(message, roots));
}

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
  // macOS ignores the XDG overrides used by the fixture. Keep HOME short and
  // canonical so its default lifecycle log path has no /tmp symlink ancestor.
  const root = await mkdtemp(
    process.platform === 'darwin' ? '/tmp/r' : join(tmpdir(), 'revo-c3b-'),
  );
  const requestedHome = process.platform === 'darwin' ? '/tmp/r' : root;
  const effectiveInstallRoot = installRoot ?? join(root, 'state');
  await mkdir(requestedHome, { recursive: true, mode: 0o700 });
  const home = await resolveToolchainFixtureHome(requestedHome);
  await Promise.all(
    ['config', 'data', 'logs', 'cache', 'run'].map((directory) =>
      mkdir(join(root, directory), { mode: 0o700 }),
    ),
  );
  const dataDir = join(effectiveInstallRoot, 'test-data', channel);
  const channelRoot = join(effectiveInstallRoot, channel);
  const diagnosticContextFor = (extra: Record<string, string> = {}): IntelFixtureContext => {
    const finalEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'logs'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_RUNTIME_DIR: join(root, 'run'),
      REVO_DATA_DIR: dataDir,
      REVO_INSTALL_ROOT: effectiveInstallRoot,
      ...extra,
    };
    const configurationEnvironment: Record<string, string | undefined> = {};
    for (const key of INTEL_CONFIGURATION_ENVIRONMENT_KEYS) {
      configurationEnvironment[key] = finalEnvironment[key];
    }
    return {
      root,
      homeDir: finalEnvironment.HOME ?? home,
      installRoot: finalEnvironment.REVO_INSTALL_ROOT ?? effectiveInstallRoot,
      channelRoot: join(finalEnvironment.REVO_INSTALL_ROOT ?? effectiveInstallRoot, channel),
      channel,
      dataDir: finalEnvironment.REVO_DATA_DIR ?? dataDir,
      port,
      pnpmNodeRecord,
      packageVersion: releaseVersion ?? '0.0.0',
      nodeVersion: process.versions.node,
      targetArchitecture: process.arch === 'x64' ? 'x64' : process.arch,
      platform: process.platform === 'darwin' ? 'darwin' : 'linux',
      configurationEnvironment,
    };
  };
  const reserved = await new LoopbackPortAllocator().reserve();
  const port = reserved.port;
  await reserved.release();
  const tools = join(root, 'tools');
  const nodeSource = join(root, 'node');
  const pnpmSource = join(root, 'pnpm');
  await mkdir(join(nodeSource, 'bin'), { recursive: true });
  await mkdir(join(pnpmSource, 'dist'), { recursive: true });
  await copyFile(process.execPath, join(nodeSource, 'bin', 'node'));
  await chmod(join(nodeSource, 'bin', 'node'), 0o755);
  await writeFile(
    join(pnpmSource, 'pnpm'),
    '#!/bin/sh\nif [ "$1" = "--version" ] || { [ "$1" = "--pm-on-fail=ignore" ] && [ "$2" = "--version" ]; }; then printf \'12.5.1\\n\'; else trap \'[ -z "${REVO_PNPM_TERMINATED:-}" ] || : >"$REVO_PNPM_TERMINATED"; exit 143\' HUP INT TERM; [ -z "${REVO_PNPM_STARTED:-}" ] || : >"$REVO_PNPM_STARTED"; while [ -n "${REVO_PNPM_HOLD:-}" ] && [ -e "$REVO_PNPM_HOLD" ]; do :; done; [ -z "${REVO_PNPM_INSTALLS:-}" ] || : >>"$REVO_PNPM_INSTALLS"; [ -n "${REVO_PNPM_FAIL:-}" ] && exit 7 || :; printf \'{"name":"pnpm:install"}\\n\'; : >"$PWD/install-complete"; fi\n',
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
    "import { appendFile, access, writeFile } from 'node:fs/promises';\nconst codes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };\nfor (const [signal, code] of Object.entries(codes)) process.once(signal, async () => { if (process.env.REVO_PNPM_TERMINATED) await writeFile(process.env.REVO_PNPM_TERMINATED, 'ack\\n'); process.exit(code); });\nconst args = process.argv.slice(2);\nif (args[0] === '--version' || (args[0] === '--pm-on-fail=ignore' && args[1] === '--version')) process.stdout.write('12.5.1\\n');\nelse { if (process.env.REVO_PNPM_STARTED) await writeFile(process.env.REVO_PNPM_STARTED, 'ready\\n'); while (process.env.REVO_PNPM_HOLD && await access(process.env.REVO_PNPM_HOLD).then(() => true, () => false)) await new Promise((resolve) => setTimeout(resolve, 10)); if (process.env.REVO_PNPM_INSTALLS) await appendFile(process.env.REVO_PNPM_INSTALLS, 'install\\n'); if (process.env.REVO_PNPM_NODE_RECORD) await writeFile(process.env.REVO_PNPM_NODE_RECORD, `${process.execPath}\\n`); if (process.env.REVO_PNPM_FAIL) process.exit(7); process.stdout.write('{\"name\":\"pnpm:install\"}\\n'); await writeFile(`${process.cwd()}/install-complete`, 'done\\n'); }\n",
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
  const postgresObserver = join(root, 'postgres-observer.mjs');
  const postgresObserverOutput = join(root, 'postgres-observer.log');
  await writeFile(postgresObserverOutput, '', { mode: 0o600 });
  await writeFile(
    postgresObserver,
    String.raw`import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

const metadata = new URL(import.meta.url);
const output = metadata.searchParams.get('output');
const fixtureRoot = metadata.searchParams.get('root');
const MAX_STDERR_BYTES = 12 * 1024;
let capturedStderrBytes = 0;

const clean = (value) => value
  .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu, '')
  .replace(/[\u0000-\u0008\u000b-\u000d\u000e-\u001f\u007f-\u009f]/gu, '')
  .replace(/\b(postgres(?:ql)?:\/\/)[^\s/@]+@/giu, '$1[redacted]@')
  .replace(/\b(password|secret|token|authorization|cookie)(\s*[:=]\s*)(["']?)[^\s,;"']+/giu, '$1$2[redacted]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer [redacted]')
  .replace(fixtureRoot ?? '', '<fixture>');
const write = (event) => {
  if (!output) return;
  try { appendFileSync(output, JSON.stringify(event) + '\\n', { mode: 0o600 }); } catch {}
};
const insideFixture = (value) => typeof fixtureRoot === 'string' &&
  (value === fixtureRoot || value.startsWith(fixtureRoot + '/'));
const postgresInvocation = (command, args, options) => {
  const executable = typeof command === 'string' ? command : '';
  const values = Array.isArray(args) ? args.map((value) => String(value)) : [];
  const dataIndex = values.indexOf('-D');
  const clusterDir = dataIndex >= 0 ? values[dataIndex + 1] : undefined;
  const cwd = typeof options?.cwd === 'string' ? options.cwd : '';
  return basename(executable) === 'postgres' &&
    executable.startsWith('/') &&
    typeof clusterDir === 'string' && insideFixture(clusterDir) &&
    insideFixture(cwd);
};
const originalSpawn = cp.spawn;
cp.spawn = (command, args, options) => {
  const values = Array.isArray(args) ? args.map((value) => String(value)) : [];
  const isServerEntry = typeof command === 'string' &&
    command === process.execPath &&
    values.length === 1 &&
    values[0].endsWith('/dist/bin/revo-server.js');
  if (isServerEntry && output && options && typeof options.env === 'object' && options.env !== null) {
    const current = typeof options.env.NODE_OPTIONS === 'string' ? options.env.NODE_OPTIONS : '';
    const option = '--import=' + metadata.href;
    const env = current.includes(option) ? options.env : { ...options.env, NODE_OPTIONS: current ? current + ' ' + option : option };
    return originalSpawn(command, args, { ...options, env });
  }
  const child = originalSpawn(command, args, options);
  if (!postgresInvocation(command, args, options)) return child;
  write({ event: 'postgres-spawn-matched', executable: basename(String(command)), cwdInsideFixture: true });
  const chunks = [];
  let bytes = 0;
  const stderr = child.stderr;
  stderr?.on('data', (chunk) => {
    if (bytes >= MAX_STDERR_BYTES || capturedStderrBytes >= MAX_STDERR_BYTES) return;
    const buffer = Buffer.from(chunk);
    const available = Math.min(MAX_STDERR_BYTES - bytes, MAX_STDERR_BYTES - capturedStderrBytes);
    const bounded = buffer.subarray(0, available);
    chunks.push(bounded);
    bytes += bounded.length;
    capturedStderrBytes += bounded.length;
  });
  child.once('error', (error) => write({ event: 'postgres-spawn-error', code: typeof error?.code === 'string' ? error.code : 'unknown' }));
  child.once('close', (code, signal) => write({
    event: 'postgres-close',
    code,
    signal,
    stderrBytes: bytes,
    stderrTruncated: bytes < capturedStderrBytes || capturedStderrBytes >= MAX_STDERR_BYTES,
    stderr: clean(Buffer.concat(chunks, bytes).toString('utf8')),
  }));
  return child;
};
syncBuiltinESMExports();
write({ event: 'observer-loaded' });
`,
    { mode: 0o600 },
  );
  const postgresObserverUrl = `${pathToFileURL(postgresObserver).href}?output=${encodeURIComponent(postgresObserverOutput)}&root=${encodeURIComponent(effectiveInstallRoot)}`;
  const preload = join(root, 'fetch-preload.mjs');
  const hookUrl = new URL('./activation-barrier.mjs', import.meta.url).href;
  await writeFile(
    preload,
    `import cp from 'node:child_process';\nimport { syncBuiltinESMExports } from 'node:module';\nimport { appendFileSync, readFileSync } from 'node:fs';\nimport { resolve } from 'node:path';\nconst originalSpawn = cp.spawn;\ncp.spawn = (command, args, options) => { const mode = process.env.REVO_TEST_ACTIVATION_FAULT; const text = [String(command), ...(args ?? [])].join(' '); if (text.includes('pnpm') && text.includes(' install')) appendFileSync(process.env.REVO_PNPM_CALLS, JSON.stringify({ command: 'pnpm', args: (args ?? []).filter((arg) => /install|frozen|prod/.test(String(arg))).length }) + '\\n'); const match = mode && args?.length === 2 && typeof options?.cwd === 'string' && args[0] === resolve(options.cwd, 'dist/bin/revo-install-activate.js'); if (match) { const hook = new URL(${JSON.stringify(hookUrl)}); hook.searchParams.set('mode', mode); hook.searchParams.set('root', process.env.REVO_INSTALL_ROOT); return originalSpawn(command, ['--import', hook.href, ...args], options); } return originalSpawn(command, args, options); };\nsyncBuiltinESMExports();\nconst map = JSON.parse(readFileSync(process.env.REVO_TEST_RESPONSES, 'utf8'));\nglobalThis.fetch = async (url) => { appendFileSync(process.env.REVO_FETCH_CALLS, \`\${url}\\n\`); const encoded = map[url]; if (encoded === undefined) return new Response(null, { status: 404 }); const body = Buffer.from(encoded, 'base64'); return { status: 200, headers: new Headers({ 'content-length': String(body.length) }), body: (async function* () { yield body; })() }; };\n`,
    { mode: 0o600 },
  );
  const activationDiagnosticProbeUrl = new URL('./activation-diagnostic-probe.mjs', import.meta.url)
    .href;
  const activationInvocationMatcherUrl = new URL(
    './activation-helper-invocation.mjs',
    import.meta.url,
  ).href;
  await appendFile(
    preload,
    `\nconst { activationHelperSpawnArguments } = await import(${JSON.stringify(activationInvocationMatcherUrl)});\nconst diagnosticOriginalSpawn = cp.spawn;\nconst diagnosticProbeUrl = ${JSON.stringify(activationDiagnosticProbeUrl)};\ncp.spawn = (command, args, options) => diagnosticOriginalSpawn(command, activationHelperSpawnArguments(command, args, options, process.env, process.env.REVO_TEST_ACTIVATION_DIAGNOSTICS === '1', diagnosticProbeUrl), options);\nsyncBuiltinESMExports();\n`,
    { mode: 0o600 },
  );
  await appendFile(
    preload,
    `\nconst postgresObserverUrl = ${JSON.stringify(postgresObserverUrl)};
const postgresObserverOriginalSpawn = cp.spawn;
cp.spawn = (command, args, options) => {
  const installRoot = process.env.REVO_INSTALL_ROOT;
  const commandPath = typeof command === 'string' ? resolve(command) : '';
  const injectObserver = process.env.REVO_TEST_POSTGRES_DIAGNOSTIC &&
    typeof options?.env === 'object' && options.env !== null &&
    typeof installRoot === 'string' &&
    commandPath.startsWith(resolve(installRoot) + '/') &&
    commandPath.endsWith('/revo') &&
    args?.[0] === 'server' && args?.[1] === 'start';
  if (!injectObserver) return postgresObserverOriginalSpawn(command, args, options);
  const current = typeof options.env.NODE_OPTIONS === 'string' ? options.env.NODE_OPTIONS : '';
  const option = '--import=' + postgresObserverUrl;
  const env = current.includes(option) ? options.env : { ...options.env, NODE_OPTIONS: current ? current + ' ' + option : option };
  return postgresObserverOriginalSpawn(command, args, { ...options, env });
};
syncBuiltinESMExports();\n`,
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
  const startInstaller = (extra: Record<string, string> = {}, diagnosticLabel?: string) => {
    assertActivationTestModes(extra, process.env);
    if (realActivation) {
      const paths = installedData.get(root) ?? new Set<string>();
      paths.add(extra.REVO_DATA_DIR ?? dataDir);
      installedData.set(root, paths);
    }
    const startedAt = new Date().toISOString();
    const diagnosticsEnabled = Boolean(diagnosticLabel && intelDiagnosticsDirectory());
    const diagnosticContext = diagnosticContextFor(extra);
    let child!: ChildProcess;
    let stdout = '';
    let stderrTail = '';
    let stdoutTail = '';
    let observedExit:
      | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
      | undefined;
    const finish = new Promise<number>((resolveFinish) => {
      const installerEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_STATE_HOME: join(root, 'logs'),
        XDG_CACHE_HOME: join(root, 'cache'),
        XDG_RUNTIME_DIR: join(root, 'run'),
        REVO_DATA_DIR: dataDir,
        REVO_PORT: String(port),
        REVO_PUBLIC_URL: `http://127.0.0.1:${port}`,
        PATH: `${tools}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        REVO_INSTALL_ROOT: effectiveInstallRoot,
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
      };
      for (const key of INTEL_ENVIRONMENT_KEYS) {
        delete installerEnvironment[key];
      }
      child = spawn('/bin/sh', [join(root, 'install.sh')], {
        env: installerEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const onStdoutData = (chunk: string) => {
        stdout += chunk.slice(0, Math.max(0, 256 * 1024 - stdout.length));
        if (diagnosticsEnabled) {
          stdoutTail = appendDiagnosticTail(stdoutTail, chunk);
        }
      };
      const onStderrData = (chunk: string) => {
        stderrTail = appendDiagnosticTail(stderrTail, chunk);
      };
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', onStdoutData);
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', onStderrData);
      type InstallerPipe = NonNullable<ChildProcess['stdout']>;
      type PipeState = {
        readonly stream: InstallerPipe;
        ended: boolean;
        closed: boolean;
        errored: boolean;
        readonly onEnd: () => void;
        readonly onClose: () => void;
        readonly onError: () => void;
      };
      const pipeWaiters = new Set<() => void>();
      const pipeStates: PipeState[] = [];
      let pipeListenersCleaned = false;
      const notifyPipeWaiters = () => {
        for (const waiter of pipeWaiters) {
          waiter();
        }
      };
      const observePipe = (stream: InstallerPipe | null): void => {
        if (!diagnosticsEnabled || !stream) {
          return;
        }
        const state: PipeState = {
          stream,
          ended: false,
          closed: false,
          errored: false,
          onEnd: () => {
            state.ended = true;
            notifyPipeWaiters();
          },
          onClose: () => {
            state.closed = true;
            notifyPipeWaiters();
          },
          onError: () => {
            state.errored = true;
            notifyPipeWaiters();
          },
        };
        pipeStates.push(state);
        stream.on('end', state.onEnd);
        stream.on('close', state.onClose);
        stream.on('error', state.onError);
      };
      observePipe(child.stdout);
      observePipe(child.stderr);
      const cleanupPipeListeners = (abandonOpenPipes: boolean) => {
        if (pipeListenersCleaned) {
          return;
        }
        pipeListenersCleaned = true;
        child.stdout?.off('data', onStdoutData);
        child.stderr?.off('data', onStderrData);
        for (const state of pipeStates) {
          state.stream.off('end', state.onEnd);
          state.stream.off('close', state.onClose);
          state.stream.off('error', state.onError);
        }
        if (abandonOpenPipes) {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
      };
      const waitForPipes = async (): Promise<boolean> => {
        let timer: NodeJS.Timeout | undefined;
        let check: (() => void) | undefined;
        let complete = false;
        const outcome = await new Promise<boolean>((resolvePipes) => {
          check = () => {
            if (pipeStates.some((state) => state.errored || (state.closed && !state.ended))) {
              resolvePipes(false);
            } else if (pipeStates.every((state) => state.ended)) {
              resolvePipes(true);
            }
          };
          pipeWaiters.add(check);
          timer = setTimeout(() => resolvePipes(false), 250);
          check();
        });
        complete = outcome;
        if (timer) {
          clearTimeout(timer);
        }
        if (check) {
          pipeWaiters.delete(check);
        }
        cleanupPipeListeners(!complete);
        return complete;
      };
      const settle = async (code: number | null, signal: NodeJS.Signals | null) => {
        observedExit = { code, signal };
        if (code !== 0 || signal !== null) {
          console.error(`Installer child exit: code=${code ?? 'null'}; signal=${signal ?? 'none'}`);
          const failureTail = redactDiagnosticText(stderrTail, [root]).slice(-4096);
          if (failureTail) {
            console.error(`Installer stderr tail: ${failureTail}`);
          }
        }
        if (diagnosticsEnabled && diagnosticLabel) {
          try {
            const pipesIncomplete = !(await waitForPipes());
            await captureIntelInstallerResult({
              context: diagnosticContext,
              label: diagnosticLabel,
              startedAt,
              code,
              signal,
              installerPid: child.pid,
              stdout: stdoutTail,
              stderr: stderrTail,
              pipesIncomplete,
            });
          } catch (error) {
            intelCollectorState.complete = false;
            const message = error instanceof Error ? error.message : String(error);
            intelCollectorState.issues.push(redactDiagnosticText(message, [root]));
            console.error(
              `Intel diagnostic collector incomplete: ${redactDiagnosticText(message, [root])}`,
            );
          }
        } else {
          cleanupPipeListeners(false);
        }
        resolveFinish(code ?? 1);
      };
      if (diagnosticsEnabled) {
        child.once('exit', (code, signal) => void settle(code, signal));
      } else {
        child.once('exit', (code, signal) => void settle(code, signal));
      }
    });
    return {
      child,
      finish,
      stdout: () => stdout,
      stdoutTail: () => redactDiagnosticText(stdout, [root]).slice(-4096),
      outcome: () => observedExit,
      stderrTail: () => redactDiagnosticText(stderrTail, [root]).slice(-4096),
    };
  };
  const runInstaller = () => startInstaller().finish;
  const attempts = async () =>
    (await readdir(channelRoot, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.name.startsWith('.attempt.') && entry.isDirectory())
      .map((entry) => join(channelRoot, entry.name));
  const runTogether = () => {
    const first = startInstaller();
    const second = startInstaller();
    return Promise.all([first.finish, second.finish]);
  };
  return {
    root,
    dataDir,
    status: () => new ServerStatusService().read(dataDir),
    stopServer: (directory = dataDir) => stopInstalledServer(directory),
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
    diagnosticContext: diagnosticContextFor(),
    initialInstallFailureDiagnostics: () =>
      collectInitialInstallFailureDiagnostics(root, channelRoot),
  };
}

export async function resolveToolchainFixtureHome(requestedHome: string): Promise<string> {
  return realpath(requestedHome);
}

export async function cleanupPortableToolchain(root: string) {
  await Promise.all([...(installedData.get(root) ?? [])].map(stopInstalledServer));
  installedData.delete(root);
  await rm(root, { recursive: true, force: true });
}

export async function runWithPortableToolchainCleanup<T>(
  root: string,
  scenario: () => Promise<T>,
  cleanup: () => Promise<void> = () => cleanupPortableToolchain(root),
): Promise<T> {
  let value!: T;
  let scenarioFailure: unknown;
  let hasScenarioFailure = false;
  try {
    value = await scenario();
  } catch (error) {
    scenarioFailure = error;
    hasScenarioFailure = true;
  }

  let cleanupFailure: unknown;
  let hasCleanupFailure = false;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = error;
    hasCleanupFailure = true;
  }

  if (hasScenarioFailure && hasCleanupFailure) {
    throw new AggregateError(
      [scenarioFailure, cleanupFailure],
      `Installer scenario failed: ${safeFailureSummary(scenarioFailure, [root])}; ` +
        `fixture cleanup failed: ${safeFailureSummary(cleanupFailure, [root])}`,
    );
  }
  if (hasScenarioFailure) {
    throw scenarioFailure;
  }
  if (hasCleanupFailure) {
    throw cleanupFailure;
  }
  return value;
}

async function stopInstalledServer(dataDir: string): Promise<void> {
  const status = await new ServerStatusService().read(dataDir);
  if (status.kind === 'stopped') {
    return;
  }
  const stopped = await new ServerStopService().stop(dataDir, 30_000);
  if (stopped.kind !== 'completed') {
    const ownership = stopped.ownership ? `; ownership=${stopped.ownership}` : '';
    throw new Error(
      `installed server cleanup was not confirmed; fixture retained; ` +
        `status=${status.kind}; stop=${stopped.kind}${ownership}`,
    );
  }
}

export async function toolchainInstaller(channel: 'stable' | 'alpha' = 'stable') {
  const { buildInstaller } = await vi.importActual<Builder>(
    new URL('../../../installer/build-installer.mjs', import.meta.url).href,
  );
  const input = pnpmReleaseManifestFixture({
    channel,
    version: channel === 'stable' ? '2.7.1' : '2.7.1-alpha.1',
    versions: { core: '4.3.2', admin: '5.4.3', node: '26.8.2', pnpm: '12.5.1' },
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
  const { buildPayload } = await vi.importActual<{
    buildPayload: (input: { readonly entry: string }) => Promise<string>;
  }>(new URL('../../../installer/build-payload.mjs', import.meta.url).href);
  const input = installerBuilderScenario({
    core: '4.3.2',
    admin: '5.4.3',
    node: '26.8.2',
    pnpm: '12.5.1',
  });
  const template = await installerTemplateBytes();
  const payload = await buildPayload({
    entry: fileURLToPath(new URL('../../../installer/node-bootstrap.mjs', import.meta.url)),
  });
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
