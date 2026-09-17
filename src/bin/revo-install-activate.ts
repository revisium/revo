import { constants, realpathSync } from 'node:fs';
import { readFile, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ActivationCandidate } from '../installation/activation-store.js';
import { ManagedActivationService } from '../installation/managed-activation.service.js';
import type { ManagedActivationOutcome } from '../installation/managed-activation.service.js';
import { parsePackageInstallPlan } from '../installation/package-install-plan.js';
import { preparedPackageTarget } from '../installation/prepared-package.js';

export const ACTIVATION_REQUEST_SCHEMA = 'revo-install-activate/v1' as const;

export interface InstallActivationRequest {
  readonly schemaVersion: typeof ACTIVATION_REQUEST_SCHEMA;
  readonly channelRoot: string;
  readonly packagePlan: unknown;
  readonly nodeArchiveSha256: string;
  readonly pnpmArchiveSha256: string;
}

const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

function request(value: unknown): InstallActivationRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('activation request is invalid');
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const channelRoot = record.channelRoot;
  const nodeArchiveSha256 = record.nodeArchiveSha256;
  const pnpmArchiveSha256 = record.pnpmArchiveSha256;
  if (
    Object.keys(value).length !== 5 ||
    !Object.keys(value).every((key) =>
      [
        'channelRoot',
        'nodeArchiveSha256',
        'packagePlan',
        'pnpmArchiveSha256',
        'schemaVersion',
      ].includes(key),
    ) ||
    record.schemaVersion !== ACTIVATION_REQUEST_SCHEMA ||
    typeof channelRoot !== 'string' ||
    !channelRoot.startsWith('/') ||
    !hash(nodeArchiveSha256) ||
    !hash(pnpmArchiveSha256)
  ) {
    throw new Error('activation request is invalid');
  }
  return {
    schemaVersion: ACTIVATION_REQUEST_SCHEMA,
    channelRoot,
    packagePlan: record.packagePlan,
    nodeArchiveSha256,
    pnpmArchiveSha256,
  };
}

export async function activateInstall(
  requestValue: unknown,
  service: Pick<ManagedActivationService, 'activate'> = new ManagedActivationService(),
) {
  const input = request(requestValue);
  const plan = parsePackageInstallPlan(input.packagePlan);
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('unsupported activation platform');
  }
  const packageDirectory = preparedPackageTarget(input.channelRoot, plan);
  const target = `${plan.target.platform}-${plan.target.arch}`;
  const candidate: ActivationCandidate = {
    plan,
    packageDirectory,
    packageBin: await packageBin(packageDirectory),
    nodeDirectory: join(input.channelRoot, 'node', plan.toolchain.node, target),
    pnpmDirectory: join(
      input.channelRoot,
      'pnpm',
      plan.toolchain.node,
      target,
      plan.toolchain.pnpm,
    ),
    nodeArchiveSha256: input.nodeArchiveSha256,
    pnpmArchiveSha256: input.pnpmArchiveSha256,
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
    process.once(signal, abort);
  }
  try {
    return await service.activate({
      channelRoot: input.channelRoot,
      candidate,
      configuration: {
        env: process.env,
        flags: {},
        homeDir: homedir(),
        packageVersion: plan.release.version,
        platform: process.platform,
        wrapperChannel: plan.release.channel,
      },
      signal: controller.signal,
    });
  } finally {
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
      process.removeListener(signal, abort);
    }
  }
}

export async function readActivationRequest(path: string, trustedRoot: string): Promise<unknown> {
  const root = realpathSync(trustedRoot);
  const parent = realpathSync(dirname(path));
  const relation = relative(root, parent);
  if (!/^\.attempt\.[^/]+\/runtime\/scratch\/\.activation-request-[^/]+$/u.test(relation)) {
    throw new Error('activation request path is invalid');
  }
  const requestPath = join(parent, 'request.json');
  const file = await open(
    requestPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 64 * 1024) {
      throw new Error('activation request is unsafe');
    }
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const result = await file.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead > 64 * 1024) {
      throw new Error('activation request is oversized');
    }
    const value = JSON.parse(buffer.subarray(0, result.bytesRead).toString('utf8'));
    if (typeof value !== 'object' || value === null || typeof value.channelRoot !== 'string') {
      throw new Error('activation request root is invalid');
    }
    if (realpathSync(value.channelRoot) !== root) {
      throw new Error('activation request root is invalid');
    }
    return value;
  } finally {
    await file.close();
  }
}

async function packageBin(directory: string): Promise<string> {
  const value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const bin = typeof value.bin === 'string' ? value.bin : value.bin?.revo;
  if (typeof bin !== 'string' || bin.startsWith('/') || bin.includes('..')) {
    throw new Error('activation package bin is invalid');
  }
  return bin;
}

const path = process.argv[2];
export async function runActivationHelper(
  requestPath: string,
  trustedRoot: string,
  activation: (value: unknown) => Promise<ManagedActivationOutcome> = activateInstall,
): Promise<number> {
  try {
    const result = await activation(await readActivationRequest(requestPath, trustedRoot));
    const valid =
      (result.status === 'activated' || result.status === 'unchanged') &&
      typeof result.generationId === 'string' &&
      /^[a-f0-9]{64}$/u.test(result.generationId);
    if (!valid) {
      process.stderr.write('activation helper failed\n');
      return 1;
    }
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: ACTIVATION_REQUEST_SCHEMA, ...result })}\n`,
    );
    return 0;
  } catch {
    process.stderr.write('activation helper failed\n');
    return 1;
  }
}

if (
  path !== undefined &&
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = await runActivationHelper(
    path,
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..'),
  );
}
