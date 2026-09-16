import { constants } from 'node:fs';
import { readFile, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ConfigurationInput } from '../configuration/configuration.types.js';
import type { ActivationCandidate } from '../installation/activation-store.js';
import { ManagedActivationService } from '../installation/managed-activation.service.js';
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
  const record = value as Record<string, unknown>;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
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
    typeof record.channelRoot !== 'string' ||
    !(typeof record.channelRoot === 'string' && record.channelRoot.startsWith('/')) ||
    !hash(record.nodeArchiveSha256) ||
    !hash(record.pnpmArchiveSha256)
  ) {
    throw new Error('activation request is invalid');
  }
  return value as InstallActivationRequest;
}

export async function activateInstall(requestValue: unknown) {
  const input = request(requestValue);
  const plan = parsePackageInstallPlan(input.packagePlan);
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
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.once(signal, abort);
  try {
    return await new ManagedActivationService().activate({
    channelRoot: input.channelRoot,
    candidate,
    configuration: {
      env: process.env,
      flags: {},
      homeDir: homedir(),
      packageVersion: plan.release.version,
      platform: process.platform === 'darwin' ? 'darwin' : 'linux',
      wrapperChannel: plan.release.channel,
    },
    signal: controller.signal,
    });
  } finally {
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.removeListener(signal, abort);
  }
}

export async function readActivationRequest(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 64 * 1024)
      throw new Error('activation request is unsafe');
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const result = await file.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead > 64 * 1024) throw new Error('activation request is oversized');
    return JSON.parse(buffer.subarray(0, result.bytesRead).toString('utf8'));
  } finally {
    await file.close();
  }
}

async function packageBin(directory: string): Promise<string> {
  const value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const bin = typeof value.bin === 'string' ? value.bin : value.bin?.revo;
  if (typeof bin !== 'string' || bin.startsWith('/') || bin.includes('..'))
    throw new Error('activation package bin is invalid');
  return bin;
}

const path = process.argv[2];
if (path !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await activateInstall(await readActivationRequest(path));
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: ACTIVATION_REQUEST_SCHEMA, ...result })}\n`,
    );
    process.exitCode = result.status === 'activated' || result.status === 'unchanged' ? 0 : 1;
  } catch {
    process.stderr.write('activation helper failed\n');
    process.exitCode = 1;
  }
}
