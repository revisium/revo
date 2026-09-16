// oxlint-disable curly, no-await-in-loop, no-unsafe-type-assertion -- bounded receipt validation

import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

import type { PackageInstallPlan } from './package-install-plan.js';

export const PREPARED_PACKAGE_SCHEMA = 'revo-package-prepared/v1' as const;
const RECEIPT_NAME = 'install-receipt.json';

export interface PreparedPackageReceipt {
  readonly schemaVersion: typeof PREPARED_PACKAGE_SCHEMA;
  readonly release: PackageInstallPlan['release'];
  readonly components: PackageInstallPlan['components'];
  readonly target: PackageInstallPlan['target'];
  readonly toolchain: PackageInstallPlan['toolchain'];
  readonly artifacts: {
    readonly package: { readonly sha256: string; readonly integrity: string };
    readonly packageJson: { readonly sha256: string };
    readonly pnpmLock: { readonly sha256: string };
    readonly pnpmWorkspace: { readonly sha256: string };
  };
}

const fail = (reason: string): Error => new Error(`prepared package: ${reason}`);
const code = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
const HASH = /^[a-f0-9]{64}$/u;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const digest = (value: PackageInstallPlan['artifacts']): PreparedPackageReceipt['artifacts'] => ({
  package: { sha256: value.package.sha256, integrity: value.package.integrity },
  packageJson: { sha256: value.packageJson.sha256 },
  pnpmLock: { sha256: value.pnpmLock.sha256 },
  pnpmWorkspace: { sha256: value.pnpmWorkspace.sha256 },
});

export const preparedPackageTarget = (channelRoot: string, plan: PackageInstallPlan): string =>
  join(channelRoot, 'package', plan.release.version, `${plan.target.platform}-${plan.target.arch}`);

export const preparedPackageReceipt = (plan: PackageInstallPlan): PreparedPackageReceipt => ({
  schemaVersion: PREPARED_PACKAGE_SCHEMA,
  release: plan.release,
  components: plan.components,
  target: plan.target,
  toolchain: plan.toolchain,
  artifacts: digest(plan.artifacts),
});

function safePath(value: string, label: string): void {
  if (!isAbsolute(value) || value.includes('\0')) throw fail(`${label} must be absolute`);
}

async function safeDirectory(value: string, label: string): Promise<void> {
  const info = await lstat(value).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return undefined;
    throw fail(`${label} is unavailable`);
  });
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink())
    throw fail(`${label} is unsafe`);
}

async function ensureParentPart(path: string): Promise<void> {
  let info = await lstat(path).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return undefined;
    throw fail('target ancestor is unavailable');
  });
  let created = false;
  if (info === undefined) {
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (code(error) !== 'EEXIST') throw fail('target ancestor is unavailable');
      info = await lstat(path).catch(() => undefined);
    }
  }
  if (info !== undefined && (!info.isDirectory() || info.isSymbolicLink()))
    throw fail('target ancestor is unsafe');
  if (info === undefined && !created) throw fail('target ancestor is unavailable');
}

async function safeParent(root: string, parent: string): Promise<void> {
  const suffix = relative(root, parent);
  if (suffix.startsWith('..') || isAbsolute(suffix)) throw fail('target escapes channelRoot');
  let current = root;
  for (const part of suffix.split('/').filter(Boolean)) {
    current = join(current, part);
    await ensureParentPart(current);
  }
}

async function existingParent(root: string, parent: string): Promise<void> {
  const suffix = relative(root, parent);
  if (suffix.startsWith('..') || isAbsolute(suffix)) throw fail('target escapes channelRoot');
  let current = root;
  for (const part of suffix.split('/').filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch((error: unknown) => {
      if (code(error) === 'ENOENT') return undefined;
      throw fail('target ancestor is unavailable');
    });
    if (info === undefined) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('target ancestor is unsafe');
  }
}

export function parsePreparedPackageReceipt(value: unknown): PreparedPackageReceipt {
  if (
    !object(value) ||
    !exact(value, ['artifacts', 'components', 'release', 'schemaVersion', 'target', 'toolchain']) ||
    value.schemaVersion !== PREPARED_PACKAGE_SCHEMA
  )
    throw fail('receipt is invalid');
  if (!object(value.release) || !object(value.target) || !object(value.toolchain))
    throw fail('receipt identity is invalid');
  if (
    !exact(value.target, ['arch', 'platform']) ||
    !exact(value.toolchain, ['node', 'pnpm']) ||
    typeof value.target.platform !== 'string' ||
    typeof value.target.arch !== 'string' ||
    typeof value.toolchain.node !== 'string' ||
    typeof value.toolchain.pnpm !== 'string'
  )
    throw fail('receipt target is invalid');
  if (
    !object(value.artifacts) ||
    !exact(value.artifacts, ['package', 'packageJson', 'pnpmLock', 'pnpmWorkspace'])
  )
    throw fail('receipt artifacts are invalid');
  for (const [name, artifact] of Object.entries(value.artifacts)) {
    if (!object(artifact) || typeof artifact.sha256 !== 'string' || !HASH.test(artifact.sha256))
      throw fail(`${name} digest is invalid`);
    if (
      name === 'package' &&
      (typeof artifact.integrity !== 'string' || !artifact.integrity.startsWith('sha512-'))
    )
      throw fail('package integrity is invalid');
  }
  return value as unknown as PreparedPackageReceipt;
}

async function regularFile(path: string, label: string): Promise<Uint8Array> {
  const info = await lstat(path).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return undefined;
    throw fail(`${label} is unavailable`);
  });
  if (info === undefined || !info.isFile() || info.isSymbolicLink())
    throw fail(`${label} is unsafe`);
  try {
    return await readFile(path);
  } catch {
    throw fail(`${label} is unavailable`);
  }
}

async function validateContents(target: string, receipt: PreparedPackageReceipt): Promise<void> {
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(
      new TextDecoder().decode(await regularFile(join(target, 'package.json'), 'package.json')),
    ) as Record<string, unknown>;
  } catch {
    throw fail('package identity is invalid');
  }
  if (
    packageJson.name !== receipt.release.npm.name ||
    packageJson.version !== receipt.release.version
  )
    throw fail('package identity is invalid');
  for (const [name, artifact] of Object.entries({
    packageJson: 'package.json',
    pnpmLock: 'pnpm-lock.yaml',
    pnpmWorkspace: 'pnpm-workspace.yaml',
  })) {
    const bytes = await regularFile(join(target, artifact), artifact);
    const expected = receipt.artifacts[name as 'packageJson' | 'pnpmLock' | 'pnpmWorkspace'].sha256;
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      throw fail(`${artifact} digest differs`);
  }
  const bins = packageJson.bin;
  const targets: unknown[] = [];
  if (typeof bins === 'string') targets.push(bins);
  else if (object(bins)) targets.push(...Object.values(bins));
  for (const value of targets) {
    if (typeof value !== 'string' || isAbsolute(value) || value.includes('..'))
      throw fail('package bin is unsafe');
    await regularFile(join(target, value), 'package bin');
  }
}

async function compatibleWinner(
  channelRoot: string,
  plan: PackageInstallPlan,
): Promise<{ readonly directory: string; readonly receipt: PreparedPackageReceipt }> {
  try {
    const directory = await readPreparedPackage(channelRoot, plan);
    if (directory === undefined) throw fail('existing target is incompatible');
    return { directory, receipt: preparedPackageReceipt(plan) };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'prepared package: existing target is incompatible'
    )
      throw error;
    throw fail('existing target is incompatible');
  }
}

export async function publishPreparedPackage({
  plan,
  stage,
  channelRoot,
}: {
  readonly plan: PackageInstallPlan;
  readonly stage: string;
  readonly channelRoot: string;
}): Promise<{ readonly directory: string; readonly receipt: PreparedPackageReceipt }> {
  safePath(stage, 'stage');
  safePath(channelRoot, 'channelRoot');
  await safeDirectory(stage, 'stage');
  await safeDirectory(channelRoot, 'channelRoot');
  const target = preparedPackageTarget(channelRoot, plan);
  const parent = dirname(target);
  await safeParent(channelRoot, parent);
  const existing = await lstat(target).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return undefined;
    throw fail('target is unavailable');
  });
  const receipt = preparedPackageReceipt(plan);
  if (existing !== undefined) return compatibleWinner(channelRoot, plan);
  try {
    await validateContents(stage, receipt);
  } catch {
    throw fail('stage is invalid');
  }
  const receiptPath = join(stage, RECEIPT_NAME);
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(receiptPath, 'wx', 0o600);
  } catch {
    throw fail('stage receipt is unavailable');
  }
  try {
    await file.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
  } finally {
    await file.close();
  }
  try {
    await rename(stage, target);
  } catch (cause) {
    if (code(cause) === 'EEXIST' || code(cause) === 'ENOTEMPTY')
      return compatibleWinner(channelRoot, plan);
    if (code(cause) === 'EXDEV') throw fail('atomic publication crossed filesystems');
    throw fail('atomic publication failed');
  }
  return { directory: target, receipt };
}

export async function readPreparedPackage(
  channelRoot: string,
  plan: PackageInstallPlan,
): Promise<string | undefined> {
  safePath(channelRoot, 'channelRoot');
  const target = preparedPackageTarget(channelRoot, plan);
  await existingParent(channelRoot, dirname(target));
  const info = await lstat(target).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return undefined;
    throw fail('target is unavailable');
  });
  if (info === undefined) return undefined;
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail('target is unsafe');
  const receiptPath = join(target, RECEIPT_NAME);
  const receiptInfo = await lstat(receiptPath).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return undefined;
    throw fail('receipt is unavailable');
  });
  if (
    receiptInfo === undefined ||
    !receiptInfo.isFile() ||
    receiptInfo.isSymbolicLink() ||
    (receiptInfo.mode & 0o777) !== 0o600
  )
    throw fail('receipt is unsafe');
  let found: PreparedPackageReceipt;
  try {
    found = parsePreparedPackageReceipt(JSON.parse(await readFile(receiptPath, 'utf8')));
  } catch {
    throw fail('receipt is invalid');
  }
  if (JSON.stringify(found) !== JSON.stringify(preparedPackageReceipt(plan)))
    throw fail('receipt does not match plan');
  await validateContents(target, found);
  const nodeModules = await lstat(join(target, 'node_modules')).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return undefined;
    throw fail('node_modules is unavailable');
  });
  if (nodeModules !== undefined && !nodeModules.isDirectory()) throw fail('node_modules is unsafe');
  return target;
}

export const validatePreparedPackage = readPreparedPackage;
