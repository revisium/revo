// oxlint-disable curly, no-unsafe-type-assertion -- bounded state validation order

import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { activationLauncher } from './activation-launcher.js';
import {
  ACTIVATION_RECORD_LIMIT,
  ActivationRecordError,
  type ActivationRecord,
  parseActivationRecord,
} from './activation-record.js';

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

export type ActivationReadResult =
  | { readonly status: 'absent' }
  | { readonly status: 'valid'; readonly record: ActivationRecord; readonly directory: string }
  | {
      readonly status: 'invalid';
      readonly reason: string;
      readonly code?: ActivationRecordError['code'];
    }
  | { readonly status: 'unavailable'; readonly reason: string };
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
  const directories = parts
    .slice(0, -1)
    .map((_, index) => join(root, ...parts.slice(0, index + 1)));
  await Promise.all(directories.map((entry) => directory(entry, 'package bin directory')));
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
function rootPath(channelRoot: string): string {
  if (!isAbsolute(channelRoot) || channelRoot.includes('\0')) throw fail('channelRoot is unsafe');
  return resolve(channelRoot);
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
  const digested = {
    packageJson: 'package.json',
    pnpmLock: 'pnpm-lock.yaml',
    pnpmWorkspace: 'pnpm-workspace.yaml',
  } as const;
  await Promise.all(
    Object.entries(digested).map(async ([name, path]) => {
      const bytes = await regularFile(join(packageRoot, path), path);
      if (
        createHash('sha256').update(bytes).digest('hex') !==
        value.packageDigests[name as keyof typeof digested].sha256
      )
        throw fail(`${path} digest differs`);
    }),
  );
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
