// oxlint-disable curly, no-await-in-loop, no-unsafe-type-assertion -- bounded state validation order

import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { activationLauncher } from './activation-launcher.js';
import {
  ACTIVATION_LAUNCHER_PROTOCOL,
  ACTIVATION_RECORD_LIMIT,
  ACTIVATION_SCHEMA,
  ActivationRecordError,
  type ActivationRecord,
  parseActivationRecord,
} from './activation-record.js';
import type { PackageInstallPlan } from './package-install-plan.js';
import { preparedPackageTarget, readPreparedPackage } from './prepared-package.js';

const fail = (reason: string): Error => new Error(`activation: ${reason}`);
const CURRENT = 'current';
const ACTIVATIONS = 'activations';
const HASH = /^[a-f0-9]{64}$/u;
const owner = (value: { readonly uid: number }): boolean =>
  typeof process.getuid !== 'function' || value.uid === process.getuid();
const safeRef = (value: string): boolean =>
  value.length > 0 &&
  !isAbsolute(value) &&
  !value.includes('\0') &&
  !value.split('/').includes('..');

export interface ActivationCandidate {
  readonly plan: PackageInstallPlan;
  readonly packageDirectory: string;
  readonly packageBin: string;
  readonly nodeDirectory: string;
  readonly pnpmDirectory: string;
  readonly nodeArchiveSha256: string;
  readonly pnpmArchiveSha256: string;
}
export interface ActivationLease {
  readonly assertHeld: () => void | Promise<void>;
}
export type ActivationReadResult =
  | { readonly status: 'absent' }
  | { readonly status: 'valid'; readonly record: ActivationRecord; readonly directory: string }
  | {
      readonly status: 'invalid';
      readonly reason: string;
      readonly code?: ActivationRecordError['code'];
    }
  | { readonly status: 'unavailable'; readonly reason: string };
export type ActivationOutcome =
  | { readonly status: 'activated'; readonly generationId: string }
  | { readonly status: 'unchanged'; readonly generationId: string }
  | { readonly status: 'busy' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'outcome-unknown' };

export async function preparedActivationGenerationId({
  channelRoot,
  candidate,
  lease,
  signal,
}: {
  readonly channelRoot: string;
  readonly candidate: ActivationCandidate;
  readonly lease: ActivationLease;
  readonly signal?: AbortSignal;
}): Promise<string | ActivationOutcome> {
  const root = rootPath(channelRoot);
  const preparation = await prepareActivation(root, candidate, undefined, lease, signal);
  if ('status' in preparation) return preparation;
  const seed = activationSeed(root, candidate, preparation.paths);
  return createHash('sha256').update(JSON.stringify(seed)).digest('hex');
}

async function statSafe(path: string, label: string, mode?: number) {
  const value = await lstat(path).catch(() => undefined);
  if (value === undefined || !owner(value) || (mode !== undefined && (value.mode & 0o777) !== mode))
    throw fail(`${label} is unsafe`);
  return value;
}
async function directory(path: string, label: string, mode?: number): Promise<void> {
  const value = await statSafe(path, label, mode);
  if (!value.isDirectory() || value.isSymbolicLink()) throw fail(`${label} is unsafe`);
}
async function regular(path: string, label: string, mode: number): Promise<void> {
  const value = await statSafe(path, label, mode);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1)
    throw fail(`${label} is unsafe`);
}
async function executable(path: string, label: string): Promise<void> {
  const value = await statSafe(path, label);
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.nlink !== 1 ||
    (value.mode & 0o500) !== 0o500 ||
    (value.mode & 0o022) !== 0 ||
    (value.mode & 0o7000) !== 0
  )
    throw fail(`${label} is unsafe`);
}
async function regularFile(path: string, label: string): Promise<Uint8Array> {
  const value = await statSafe(path, label);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1)
    throw fail(`${label} is unsafe`);
  return readFile(path);
}
async function readableArtifact(root: string, path: string): Promise<Uint8Array> {
  const parts = relative(root, path).split('/').filter(Boolean);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    await directory(current, 'package bin directory');
  }
  const info = await statSafe(path, 'package bin');
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (info.mode & 0o400) === 0 ||
    (info.mode & 0o022) !== 0 ||
    (info.mode & 0o7000) !== 0
  )
    throw fail('package bin is unsafe');
  return readFile(path);
}
function declaredBin(value: Record<string, unknown>): string {
  const bins = value.bin;
  let result = '';
  if (typeof bins === 'string') {
    result = bins;
  } else if (bins !== null && typeof bins === 'object' && !Array.isArray(bins)) {
    const revo = (bins as Record<string, unknown>).revo;
    if (typeof revo === 'string') result = revo;
  }
  if (!safeRef(result)) throw fail('package bin is invalid');
  return result;
}
async function sync(path: string): Promise<void> {
  const file = await open(path, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
function rootPath(channelRoot: string): string {
  if (!isAbsolute(channelRoot) || channelRoot.includes('\0')) throw fail('channelRoot is unsafe');
  return resolve(channelRoot);
}
function nodePath(candidate: ActivationCandidate, root: string): string {
  return join(
    root,
    'node',
    candidate.plan.toolchain.node,
    `${candidate.plan.target.platform}-${candidate.plan.target.arch}`,
  );
}
function pnpmPath(candidate: ActivationCandidate, root: string): string {
  return join(
    root,
    'pnpm',
    candidate.plan.toolchain.node,
    `${candidate.plan.target.platform}-${candidate.plan.target.arch}`,
    candidate.plan.toolchain.pnpm,
  );
}
async function receipt(path: string, expected: unknown): Promise<void> {
  await regular(path, 'toolchain receipt', 0o600);
  const text = await readFile(path, 'utf8');
  if (
    text.length > ACTIVATION_RECORD_LIMIT ||
    JSON.stringify(JSON.parse(text)) !== JSON.stringify(expected)
  )
    throw fail('toolchain receipt is incompatible');
}
async function validateActivePackage(root: string, value: ActivationRecord): Promise<void> {
  const packageRoot = join(root, value.packageRef);
  await directory(packageRoot, 'prepared package');
  await regular(join(packageRoot, 'install-receipt.json'), 'package receipt', 0o600);
  const packageReceipt = JSON.parse(
    new TextDecoder().decode(
      await regularFile(join(packageRoot, 'install-receipt.json'), 'package receipt'),
    ),
  );
  const expected = {
    schemaVersion: 'revo-package-prepared/v1',
    release: value.release,
    components: value.components,
    target: value.target,
    toolchain: { node: value.toolchain.nodeVersion, pnpm: value.toolchain.pnpmVersion },
    artifacts: value.packageDigests,
  };
  if (JSON.stringify(packageReceipt) !== JSON.stringify(expected))
    throw fail('prepared package receipt differs');
  const packageJson = JSON.parse(
    new TextDecoder().decode(await regularFile(join(packageRoot, 'package.json'), 'package.json')),
  ) as Record<string, unknown>;
  if (packageJson.name !== value.release.npm.name || packageJson.version !== value.release.version)
    throw fail('prepared package identity differs');
  if (declaredBin(packageJson) !== value.packageBin) throw fail('package bin differs');
  for (const [name, path] of Object.entries({
    packageJson: 'package.json',
    pnpmLock: 'pnpm-lock.yaml',
    pnpmWorkspace: 'pnpm-workspace.yaml',
  })) {
    const bytes = await regularFile(join(packageRoot, path), path);
    if (
      createHash('sha256').update(bytes).digest('hex') !==
      value.packageDigests[name as keyof typeof value.packageDigests].sha256
    )
      throw fail(`${path} digest differs`);
  }
}

async function validateCandidate(candidate: ActivationCandidate, root: string) {
  if (
    !candidate ||
    !HASH.test(candidate.nodeArchiveSha256) ||
    !HASH.test(candidate.pnpmArchiveSha256) ||
    !safeRef(candidate.packageBin) ||
    candidate.packageBin.includes('..')
  )
    throw fail('candidate is invalid');
  const packageDirectory = preparedPackageTarget(root, candidate.plan);
  const nodeDirectory = nodePath(candidate, root);
  const pnpmDirectory = pnpmPath(candidate, root);
  if (
    candidate.packageDirectory !== packageDirectory ||
    candidate.nodeDirectory !== nodeDirectory ||
    candidate.pnpmDirectory !== pnpmDirectory
  )
    throw fail('candidate paths are incompatible');
  if ((await readPreparedPackage(root, candidate.plan)) !== packageDirectory)
    throw fail('prepared package is unavailable');
  const packageJson = JSON.parse(
    new TextDecoder().decode(
      await regularFile(join(packageDirectory, 'package.json'), 'package.json'),
    ),
  ) as Record<string, unknown>;
  if (declaredBin(packageJson) !== candidate.packageBin) throw fail('package bin differs');
  await readableArtifact(root, join(packageDirectory, candidate.packageBin));
  await directory(nodeDirectory, 'Node target');
  await executable(join(nodeDirectory, 'bin', 'node'), 'Node executable');
  await receipt(join(nodeDirectory, 'install-receipt.json'), {
    version: candidate.plan.toolchain.node,
    target: `${candidate.plan.target.platform}-${candidate.plan.target.arch}`,
    archiveSha256: candidate.nodeArchiveSha256,
  });
  await directory(pnpmDirectory, 'pnpm target');
  await executable(join(pnpmDirectory, 'pnpm'), 'pnpm executable');
  await receipt(join(pnpmDirectory, 'install-receipt.json'), {
    schemaVersion: 'revo-pnpm-bootstrap/v1',
    version: candidate.plan.toolchain.pnpm,
    nodeVersion: candidate.plan.toolchain.node,
    platform: candidate.plan.target.platform,
    arch: candidate.plan.target.arch,
    archiveSha256: candidate.pnpmArchiveSha256,
  });
  return { packageDirectory, nodeDirectory, pnpmDirectory };
}

async function inspect(root: string, generationId: string): Promise<ActivationReadResult> {
  if (!HASH.test(generationId)) return { status: 'invalid', reason: 'generation id is invalid' };
  const directoryPath = join(root, ACTIVATIONS, generationId);
  try {
    await directory(directoryPath, 'generation', 0o700);
    const manifest = join(directoryPath, 'activation.json');
    await regular(manifest, 'activation record', 0o600);
    const text = await readFile(manifest, 'utf8');
    if (text.length > ACTIVATION_RECORD_LIMIT) throw fail('activation record is too large');
    const value = parseActivationRecord(JSON.parse(text));
    if (
      value.generationId !== generationId ||
      !safeRef(value.packageRef) ||
      !safeRef(value.packageBin) ||
      !safeRef(value.toolchain.nodeRef) ||
      !safeRef(value.toolchain.pnpmRef)
    )
      throw fail('activation references are unsafe');
    await regular(join(directoryPath, 'revo'), 'activation entrypoint', 0o700);
    if ((await readFile(join(directoryPath, 'revo'), 'utf8')) !== activationLauncher(root, value))
      throw fail('activation entrypoint differs');
    await validateActivePackage(root, value);
    await readableArtifact(root, join(root, value.packageRef, value.packageBin));
    await directory(join(root, value.toolchain.nodeRef), 'Node target');
    await executable(join(root, value.toolchain.nodeRef, 'bin', 'node'), 'Node executable');
    await receipt(join(root, value.toolchain.nodeRef, 'install-receipt.json'), {
      version: value.toolchain.nodeVersion,
      target: `${value.target.platform}-${value.target.arch}`,
      archiveSha256: value.toolchain.nodeArchiveSha256,
    });
    await directory(join(root, value.toolchain.pnpmRef), 'pnpm target');
    await executable(join(root, value.toolchain.pnpmRef, 'pnpm'), 'pnpm executable');
    await receipt(join(root, value.toolchain.pnpmRef, 'install-receipt.json'), {
      schemaVersion: 'revo-pnpm-bootstrap/v1',
      version: value.toolchain.pnpmVersion,
      nodeVersion: value.toolchain.nodeVersion,
      platform: value.target.platform,
      arch: value.target.arch,
      archiveSha256: value.toolchain.pnpmArchiveSha256,
    });
    return { status: 'valid', record: value, directory: directoryPath };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'state is invalid';
    return {
      status: 'invalid',
      reason,
      ...(error instanceof ActivationRecordError ? { code: error.code } : {}),
    };
  }
}

export async function readActivation(channelRoot: string): Promise<ActivationReadResult> {
  let root: string;
  try {
    root = rootPath(channelRoot);
    await directory(root, 'channelRoot');
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : 'channelRoot is unavailable',
    };
  }
  const current = join(root, CURRENT);
  const value = await lstat(current).catch(() => undefined);
  if (value === undefined) return { status: 'absent' };
  if (!value.isSymbolicLink() || !owner(value) || value.nlink !== 1)
    return { status: 'invalid', reason: 'current pointer is unsafe' };
  const pointer = await readlink(current);
  const match = /^activations\/([a-f0-9]{64})$/u.exec(pointer);
  if (match?.[1] === undefined) return { status: 'invalid', reason: 'current pointer is invalid' };
  return inspect(root, match[1]);
}

function expectedGeneration(
  value: ActivationReadResult | string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string') return value;
  if (value.status === 'valid') return value.record.generationId;
  if (value.status === 'absent') return null;
  return undefined;
}
type ActivationPreparation = {
  current: ActivationReadResult;
  expected: string | null | undefined;
  paths: Awaited<ReturnType<typeof validateCandidate>>;
};

async function prepareActivation(
  root: string,
  candidate: ActivationCandidate,
  expectedCurrent: ActivationReadResult | string | null | undefined,
  lease: ActivationLease,
  signal?: AbortSignal,
): Promise<ActivationPreparation | ActivationOutcome> {
  if (signal?.aborted) return { status: 'cancelled' };
  if (typeof lease?.assertHeld !== 'function') throw fail('lease is required');
  try {
    await lease.assertHeld();
  } catch {
    return { status: 'busy' };
  }
  const current = await readActivation(root);
  if (current.status === 'unavailable' || current.status === 'invalid') throw fail(current.reason);
  const expected = expectedGeneration(expectedCurrent);
  const actual = current.status === 'absent' ? null : current.record.generationId;
  if (expected !== undefined && actual !== expected) return { status: 'busy' };
  return { current, expected, paths: await validateCandidate(candidate, root) };
}

function activationSeed(
  root: string,
  candidate: ActivationCandidate,
  paths: Awaited<ReturnType<typeof validateCandidate>>,
) {
  return {
    channel: candidate.plan.release.channel,
    launcherProtocol: ACTIVATION_LAUNCHER_PROTOCOL,
    target: candidate.plan.target,
    release: candidate.plan.release,
    components: candidate.plan.components,
    packageRef: relative(root, paths.packageDirectory),
    packageBin: candidate.packageBin,
    packageDigests: {
      package: {
        sha256: candidate.plan.artifacts.package.sha256,
        integrity: candidate.plan.artifacts.package.integrity,
      },
      packageJson: { sha256: candidate.plan.artifacts.packageJson.sha256 },
      pnpmLock: { sha256: candidate.plan.artifacts.pnpmLock.sha256 },
      pnpmWorkspace: { sha256: candidate.plan.artifacts.pnpmWorkspace.sha256 },
    },
    toolchain: {
      nodeRef: relative(root, paths.nodeDirectory),
      pnpmRef: relative(root, paths.pnpmDirectory),
      nodeVersion: candidate.plan.toolchain.node,
      pnpmVersion: candidate.plan.toolchain.pnpm,
      nodeArchiveSha256: candidate.nodeArchiveSha256,
      pnpmArchiveSha256: candidate.pnpmArchiveSha256,
    },
  };
}

async function renameGeneration(temporary: string, target: string): Promise<void> {
  try {
    await rename(temporary, target);
  } catch (error) {
    if ((error as { code?: string }).code === 'EXDEV')
      throw fail('generation publication crossed filesystems');
    throw error;
  }
}

async function stageGeneration(
  root: string,
  generationId: string,
  seed: Omit<ActivationRecord, 'schemaVersion' | 'generationId' | 'previousGeneration'>,
  previousGeneration: string | null,
): Promise<{
  temporary: string;
  finalDirectory: string;
  pointerTemp: string;
  finalRecord: ActivationRecord;
}> {
  const activations = join(root, ACTIVATIONS);
  const activationInfo = await lstat(activations).catch(() => undefined);
  if (activationInfo === undefined) await mkdir(activations, { mode: 0o700 });
  else await directory(activations, 'activations', 0o700);
  const temporary = await mkdtemp(join(activations, '.activation-'));
  const finalDirectory = join(activations, generationId);
  const finalRecord: ActivationRecord = {
    ...seed,
    schemaVersion: ACTIVATION_SCHEMA,
    launcherProtocol: ACTIVATION_LAUNCHER_PROTOCOL,
    generationId,
    previousGeneration,
  };
  await writeFile(join(temporary, 'activation.json'), `${JSON.stringify(finalRecord)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(join(temporary, 'revo'), activationLauncher(root, finalRecord), {
    mode: 0o700,
    flag: 'wx',
  });
  await sync(join(temporary, 'activation.json'));
  await sync(join(temporary, 'revo'));
  await sync(temporary);
  const existing = await lstat(finalDirectory).catch(() => undefined);
  if (existing === undefined) await renameGeneration(temporary, finalDirectory);
  else {
    const inspected = await inspect(root, generationId);
    if (
      inspected.status !== 'valid' ||
      JSON.stringify(inspected.record) !== JSON.stringify(finalRecord)
    )
      throw fail('generation already exists');
    await rm(temporary, { recursive: true, force: true });
  }
  return {
    temporary,
    finalDirectory,
    pointerTemp: join(root, `.current-${generationId}`),
    finalRecord,
  };
}

async function commitGeneration(
  root: string,
  stage: Awaited<ReturnType<typeof stageGeneration>>,
  expected: string | null | undefined,
  lease: ActivationLease,
  signal?: AbortSignal,
): Promise<{ outcome: ActivationOutcome; committed: boolean }> {
  const pointer = join(root, CURRENT);
  await symlink(join(ACTIVATIONS, stage.finalRecord.generationId), stage.pointerTemp);
  await lease.assertHeld();
  if (signal?.aborted) return { outcome: { status: 'cancelled' }, committed: false };
  const reread = await readActivation(root);
  const now = reread.status === 'valid' ? reread.record.generationId : null;
  if (expected !== undefined && now !== expected)
    return { outcome: { status: 'busy' }, committed: false };
  // The reread is asynchronous; cancellation may win while it is in flight.
  // Never publish a pointer after that boundary has been crossed.
  if (signal?.aborted) return { outcome: { status: 'cancelled' }, committed: false };
  try {
    await rename(stage.pointerTemp, pointer);
  } catch (error) {
    if ((error as { code?: string }).code === 'EXDEV')
      throw fail('pointer publication crossed filesystems');
    throw error;
  }
  await sync(root);
  const result = await readActivation(root);
  if (result.status !== 'valid' || result.record.generationId !== stage.finalRecord.generationId)
    return { outcome: { status: 'outcome-unknown' }, committed: true };
  return {
    outcome: { status: 'activated', generationId: stage.finalRecord.generationId },
    committed: true,
  };
}

export async function activatePreparedInstallation({
  channelRoot,
  candidate,
  expectedCurrent,
  lease,
  signal,
}: {
  readonly channelRoot: string;
  readonly candidate: ActivationCandidate;
  readonly expectedCurrent?: ActivationReadResult | string | null;
  readonly lease: ActivationLease;
  readonly signal?: AbortSignal;
}): Promise<ActivationOutcome> {
  const root = rootPath(channelRoot);
  const preparation = await prepareActivation(root, candidate, expectedCurrent, lease, signal);
  if ('status' in preparation) return preparation;
  const { current, expected } = preparation;
  const seed = activationSeed(root, candidate, preparation.paths);
  const generationId = createHash('sha256').update(JSON.stringify(seed)).digest('hex');
  if (current.status === 'valid' && current.record.generationId === generationId)
    return { status: 'unchanged', generationId };
  const previousGeneration = current.status === 'valid' ? current.record.generationId : null;
  const stage = await stageGeneration(root, generationId, seed, previousGeneration);
  let committed = false;
  try {
    const result = await commitGeneration(root, stage, expected, lease, signal);
    committed = result.committed;
    return result.outcome;
  } finally {
    if (!committed) {
      await rm(stage.temporary, { recursive: true, force: true }).catch(() => undefined);
      await rm(stage.pointerTemp, { force: true }).catch(() => undefined);
    }
  }
}
