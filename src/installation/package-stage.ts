// oxlint-disable curly, no-await-in-loop -- sequential extraction preserves tar order and owned cleanup

import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { verifyReleaseArtifact } from './artifact-integrity.js';
import {
  acquirePackageArtifacts,
  type PackageArtifactName,
  type PackageArtifactPolicy,
  type PackageArtifactRequest,
} from './package-artifacts.js';
import type { PackageInstallPlan } from './package-install-plan.js';

const error = (reason: string): Error => new Error(`package stage: ${reason}`);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stable(value[key])]),
  );
};
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const semver =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const lifecycle = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'postpublish',
]);

interface TarEntry {
  readonly path: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}
const field = (header: Uint8Array, start: number, length: number): string => {
  const end = header.indexOf(0, start);
  return text(header.slice(start, end < 0 ? start + length : end)).trim();
};
const octal = (header: Uint8Array, start: number, length: number): number => {
  const value = field(header, start, length).replaceAll('\0', '');
  if (!/^[0-7]+$/u.test(value)) throw error('tar size is invalid');
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) throw error('tar size is unsafe');
  return result;
};
const tarPath = (header: Uint8Array): string => {
  const name = field(header, 0, 100);
  const prefix = field(header, 345, 155);
  const value = prefix ? `${prefix}/${name}` : name;
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  )
    throw error('tar path is unsafe');
  const normalized = posix.normalize(value);
  if (
    normalized !== value ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  )
    throw error('tar path traverses stage');
  return normalized;
};
function parseTar /* NOSONAR -- bounded tar state machine rejects every unsafe transition */(
  input: Uint8Array,
  maxEntries = 10_000,
  maxBytes = 512 * 1024 * 1024,
): TarEntry[] {
  let bytes = input;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = gunzipSync(bytes, { maxOutputLength: maxBytes });
    } catch {
      throw error('tar gzip is invalid');
    }
  }
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let total = 0;
  let zeros = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.slice(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      if (++zeros === 2) break;
      continue;
    }
    zeros = 0;
    if (entries.length >= maxEntries) throw error('tar has too many entries');
    const path = tarPath(header);
    const type = String.fromCodePoint(header[156] || 0);
    if (!['0', '5'].includes(type)) throw error(`tar entry type ${type || 'unknown'} is forbidden`);
    const size = octal(header, 124, 12);
    if (size > maxBytes - total || offset + size > bytes.length)
      throw error('tar size exceeds limit');
    if (seen.has(path)) throw error('tar contains duplicate paths');
    for (let parent = path; parent.includes('/');) {
      parent = parent.slice(0, parent.lastIndexOf('/'));
      if (seen.has(parent) && entries.find((entry) => entry.path === parent)?.type === '0')
        throw error('tar file conflicts with child');
    }
    if (
      type === '0' &&
      entries.some(
        (entry) =>
          (entry.type === '0' && path.startsWith(`${entry.path}/`)) ||
          entry.path.startsWith(`${path}/`),
      )
    )
      throw error('tar file conflicts with ancestor');
    seen.add(path);
    const content = bytes.slice(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    entries.push({ path, type, bytes: content });
    total += size;
  }
  if (zeros < 2) throw error('tar terminator is missing');
  return entries;
}
const packageJson = (bytes: Uint8Array): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(text(bytes));
  } catch {
    throw error('package.json is invalid JSON');
  }
  if (!object(value)) throw error('package.json is not an object');
  return value;
};
const dependency = (value: Record<string, unknown>, name: string): string | undefined => {
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = value[section];
    if (object(deps) && typeof deps[name] === 'string') return deps[name];
  }
  return undefined;
};
const validatePackage = (value: Record<string, unknown>, plan: PackageInstallPlan): void => {
  if (value.name !== plan.release.npm.name || value.version !== plan.release.version)
    throw error('package identity does not match release');
  for (const component of [plan.components.core, plan.components.admin]) {
    if (dependency(value, component.name) !== component.version)
      throw error(`package dependency ${component.name} does not match`);
  }
  const escapedVersion = plan.toolchain.pnpm.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  const packageManager = new RegExp(String.raw`^pnpm@${escapedVersion}(?:\+[^\s]+)?$`, 'u');
  if (typeof value.packageManager !== 'string' || !packageManager.test(value.packageManager))
    throw error('packageManager does not match toolchain');
  const scripts = value.scripts;
  if (
    object(scripts) &&
    Object.keys(scripts).some((name) => lifecycle.has(name) || name.includes('*'))
  )
    throw error('package lifecycle script is forbidden');
  if ('hooks' in value || (object(value.pnpm) && 'hooks' in value.pnpm))
    throw error('ambient package hooks are forbidden');
  if (
    Array.isArray(value.workspaces) &&
    value.workspaces.some(
      (item) => typeof item !== 'string' || item.startsWith('../') || isAbsolute(item),
    )
  )
    throw error('package workspace is external');
};
const validateWorkspace = (bytes: Uint8Array, plan: PackageInstallPlan): void => {
  const value = text(bytes);
  const lines = value.split('\n');
  if (
    lines.some((line) => {
      const item = line.trimStart();
      return (
        item.startsWith('- ../') ||
        item.startsWith('- /') ||
        item.includes('workspace: ../') ||
        item.includes('workspace: /')
      );
    })
  )
    throw error('workspace contains an external path');
  const index = lines.findIndex((line) => line.trimStart().startsWith('allowBuilds:'));
  if (index < 0) throw error('workspace allowBuilds is missing');
  const allowLine = lines[index];
  if (allowLine === undefined) throw error('workspace allowBuilds is missing');
  const first = allowLine.slice(allowLine.indexOf(':') + 1).trim();
  const raw =
    first.startsWith('[') && first.endsWith(']')
      ? first.slice(1, -1)
      : lines
          .slice(index + 1)
          .filter((line) => line.trimStart().startsWith('-'))
          .join('\n');
  const entries = raw
    .split(/[\n,]/u)
    .map((item) => item.replace(/["'\s-]/gu, ''))
    .filter(Boolean);
  if (
    !entries.length ||
    entries.some(
      (item) => !item.includes('@') || !semver.test(item.slice(item.lastIndexOf('@') + 1)),
    )
  )
    throw error('workspace allowBuilds must be version-qualified');
  const versions = new Map([
    [plan.components.core.name, plan.components.core.version],
    [plan.components.admin.name, plan.components.admin.version],
  ]);
  for (const item of entries) {
    const at = item.lastIndexOf('@');
    if (versions.has(item.slice(0, at)) && versions.get(item.slice(0, at)) !== item.slice(at + 1))
      throw error('workspace allowBuilds version does not match plan');
  }
};

export interface PackageStage {
  readonly directory: string;
  readonly packageDirectory: string;
  readonly packageJsonPath: string;
  readonly pnpmLockPath: string;
  readonly pnpmWorkspacePath: string;
  readonly version: string;
}
export interface AcquiredPackageArtifacts {
  readonly directory: string;
  readonly files: { readonly [Name in PackageArtifactName]: string };
  readonly bytes: { readonly [Name in PackageArtifactName]: Uint8Array };
}
export async function stagePackageArtifacts({
  plan,
  acquired,
  onProgress,
}: {
  readonly plan: PackageInstallPlan;
  readonly acquired: AcquiredPackageArtifacts;
  readonly onProgress?: (stage: string) => void;
}): Promise<PackageStage> {
  const info = await lstat(acquired.directory).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw error('acquisition directory is unsafe');
  const directory = await mkdtemp(join(acquired.directory, '..', '.package-stage-'));
  let transferred = false;
  try {
    onProgress?.('extract');
    for (const name of ['package', 'packageJson', 'pnpmLock', 'pnpmWorkspace'] as const)
      verifyReleaseArtifact(acquired.bytes[name], plan.artifacts[name]);
    const entries = parseTar(acquired.bytes.package);
    const packageEntries = entries.filter(
      (entry) => entry.path === 'package' || entry.path.startsWith('package/'),
    );
    if (packageEntries.length !== entries.length)
      throw error('tar contains files outside package root');
    if (packageEntries.some((entry) => entry.path === 'package' && entry.type !== '5'))
      throw error('package root is not a directory');
    for (const entry of packageEntries) {
      const relative = entry.path.slice('package'.length).replace(/^\//u, '');
      const target = relative ? join(directory, relative) : directory;
      if (entry.type === '5') await mkdir(target, { recursive: true, mode: 0o700 });
      else {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, entry.bytes, { flag: 'wx', mode: 0o600 });
      }
    }
    const embedded = packageJson(await readFile(join(directory, 'package.json')));
    const sidecar = packageJson(acquired.bytes.packageJson);
    if (!same(embedded, sidecar)) throw error('package.json sidecar differs from tar');
    validatePackage(embedded, plan);
    validateWorkspace(acquired.bytes.pnpmWorkspace, plan);
    await writeFile(join(directory, 'pnpm-lock.yaml'), acquired.bytes.pnpmLock, {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(join(directory, 'pnpm-workspace.yaml'), acquired.bytes.pnpmWorkspace, {
      flag: 'wx',
      mode: 0o600,
    });
    transferred = true;
    return {
      directory,
      packageDirectory: directory,
      packageJsonPath: join(directory, 'package.json'),
      pnpmLockPath: join(directory, 'pnpm-lock.yaml'),
      pnpmWorkspacePath: join(directory, 'pnpm-workspace.yaml'),
      version: plan.release.version,
    };
  } finally {
    if (!transferred) await rm(directory, { recursive: true, force: true }).catch(() => {});
    if (transferred) await rm(acquired.directory, { recursive: true, force: true }).catch(() => {});
  }
}
export async function acquireAndStagePackage({
  plan,
  scratch,
  policy,
  signal,
  request,
  onProgress,
}: {
  readonly plan: PackageInstallPlan;
  readonly scratch: string;
  readonly policy?: PackageArtifactPolicy;
  readonly signal?: AbortSignal;
  readonly request?: PackageArtifactRequest;
  readonly onProgress?: (stage: string, artifact?: PackageArtifactName) => void;
}): Promise<PackageStage> {
  const acquired = await acquirePackageArtifacts({
    plan,
    scratch,
    ...(policy === undefined ? {} : { policy }),
    ...(signal === undefined ? {} : { signal }),
    ...(request === undefined ? {} : { request }),
    ...(onProgress === undefined ? {} : { onProgress }),
  });
  try {
    return await stagePackageArtifacts({
      plan,
      acquired,
      onProgress: (stage) => onProgress?.(stage),
    });
  } catch (cause) {
    await rm(acquired.directory, { recursive: true, force: true }).catch(() => {});
    throw cause;
  }
}
export const stagePackage = stagePackageArtifacts;
