import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { activationLauncher } from '../../src/installation/activation-launcher.js';
import type { ActivationRecord } from '../../src/installation/activation-record.js';
import { readActivation } from '../../src/installation/activation-store.js';

const GENERATION = 'a'.repeat(64);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

async function file(path: string, content: string, mode: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  await chmod(path, mode);
}

async function channelWithActivation(): Promise<{ root: string; record: ActivationRecord }> {
  const root = await mkdtemp(join(tmpdir(), 'revo-activation-read-'));
  roots.push(root);
  const files = {
    packageJson: json({
      name: '@revisium/revo',
      version: '1.0.0-alpha.1',
      bin: { revo: 'dist/bin/revo.js' },
    }),
    pnpmLock: 'lockfileVersion: 9\n',
    pnpmWorkspace: 'packages: []\n',
  };
  const record: ActivationRecord = {
    schemaVersion: 'revo-activation/v1',
    launcherProtocol: 'revo-activation-launcher/v2',
    generationId: GENERATION,
    channel: 'alpha',
    target: { platform: 'linux', arch: 'x64' },
    release: {
      channel: 'alpha',
      npm: { distTag: 'alpha', name: '@revisium/revo' },
      schemaVersion: 1,
      version: '1.0.0-alpha.1',
    },
    components: {
      core: { name: '@revisium/revo-core', version: '0.0.0' },
      admin: { name: '@revisium/revo-admin', version: '0.0.0' },
    },
    packageRef: 'package',
    packageBin: 'dist/bin/revo.js',
    packageDigests: {
      package: { sha256: 'b'.repeat(64), integrity: 'sha512-AAAA' },
      packageJson: { sha256: sha256(files.packageJson) },
      pnpmLock: { sha256: sha256(files.pnpmLock) },
      pnpmWorkspace: { sha256: sha256(files.pnpmWorkspace) },
    },
    toolchain: {
      nodeRef: 'node/26.8.2/linux-x64',
      pnpmRef: 'pnpm/26.8.2/linux-x64/12.8.2',
      nodeVersion: '26.8.2',
      pnpmVersion: '12.8.2',
      nodeArchiveSha256: 'c'.repeat(64),
      pnpmArchiveSha256: 'd'.repeat(64),
    },
    previousGeneration: null,
  };
  const generation = join(root, 'activations', GENERATION);
  await mkdir(generation, { recursive: true, mode: 0o700 });
  await chmod(generation, 0o700);
  await file(join(generation, 'activation.json'), json(record), 0o600);
  await file(join(generation, 'revo'), activationLauncher(root, record), 0o700);
  await symlink(join('activations', GENERATION), join(root, 'current'));

  const pkg = join(root, 'package');
  await file(
    join(pkg, 'install-receipt.json'),
    json({
      schemaVersion: 'revo-package-prepared/v1',
      release: record.release,
      components: record.components,
      target: record.target,
      toolchain: { node: '26.8.2', pnpm: '12.8.2' },
      artifacts: record.packageDigests,
    }),
    0o600,
  );
  await file(join(pkg, 'package.json'), files.packageJson, 0o600);
  await file(join(pkg, 'pnpm-lock.yaml'), files.pnpmLock, 0o600);
  await file(join(pkg, 'pnpm-workspace.yaml'), files.pnpmWorkspace, 0o600);
  await file(join(pkg, 'dist/bin/revo.js'), '#!/usr/bin/env node\n', 0o644);

  const node = join(root, record.toolchain.nodeRef);
  await file(join(node, 'bin/node'), '', 0o700);
  await file(
    join(node, 'install-receipt.json'),
    json({
      version: '26.8.2',
      target: 'linux-x64',
      archiveSha256: record.toolchain.nodeArchiveSha256,
    }),
    0o600,
  );
  const pnpm = join(root, record.toolchain.pnpmRef);
  await file(join(pnpm, 'pnpm'), '', 0o700);
  await file(
    join(pnpm, 'install-receipt.json'),
    json({
      schemaVersion: 'revo-pnpm-bootstrap/v1',
      version: '12.8.2',
      nodeVersion: '26.8.2',
      platform: 'linux',
      arch: 'x64',
      archiveSha256: record.toolchain.pnpmArchiveSha256,
    }),
    0o600,
  );
  return { root, record };
}

describe('activation record reading', () => {
  it('reports a channel without a current pointer as absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-activation-read-'));
    roots.push(root);

    expect(await readActivation(root)).toEqual({ status: 'absent' });
  });

  it('reports a missing or relative channel root as unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-activation-read-'));
    roots.push(root);

    expect(await readActivation(join(root, 'missing'))).toMatchObject({ status: 'unavailable' });
    expect(await readActivation('relative/channel')).toMatchObject({ status: 'unavailable' });
  });

  it('accepts the complete current generation', async () => {
    const { root, record } = await channelWithActivation();

    expect(await readActivation(root)).toEqual({
      status: 'valid',
      record,
      directory: join(root, 'activations', GENERATION),
    });
  });

  it('rejects a record without the launcher protocol revision as incompatible', async () => {
    const { root, record } = await channelWithActivation();
    const { launcherProtocol: _removed, ...legacy } = record;
    await file(join(root, 'activations', GENERATION, 'activation.json'), json(legacy), 0o600);

    expect(await readActivation(root)).toMatchObject({
      status: 'invalid',
      code: 'REVO_ACTIVATION_STATE_INCOMPATIBLE',
    });
  });

  it('rejects an unsafe current pointer and a pointer outside the activations', async () => {
    const { root } = await channelWithActivation();
    await rm(join(root, 'current'));
    await symlink('../elsewhere', join(root, 'current'));
    expect(await readActivation(root)).toEqual({
      status: 'invalid',
      reason: 'current pointer is invalid',
    });

    await rm(join(root, 'current'));
    await mkdir(join(root, 'current'));
    expect(await readActivation(root)).toEqual({
      status: 'invalid',
      reason: 'current pointer is unsafe',
    });
  });

  it('rejects a tampered launcher entrypoint', async () => {
    const { root } = await channelWithActivation();
    await file(join(root, 'activations', GENERATION, 'revo'), '#!/bin/sh\nexit 0\n', 0o700);

    expect(await readActivation(root)).toEqual({
      status: 'invalid',
      reason: 'activation: activation entrypoint differs',
    });
  });

  it('rejects a package file whose digest differs from the record', async () => {
    const { root } = await channelWithActivation();
    await file(join(root, 'package', 'pnpm-lock.yaml'), 'tampered\n', 0o600);

    expect(await readActivation(root)).toEqual({
      status: 'invalid',
      reason: 'activation: pnpm-lock.yaml digest differs',
    });
  });

  it('rejects a package bin reached through a symlinked directory', async () => {
    const { root } = await channelWithActivation();
    await rm(join(root, 'package', 'dist'), { recursive: true });
    await mkdir(join(root, 'elsewhere', 'bin'), { recursive: true });
    await file(join(root, 'elsewhere', 'bin', 'revo.js'), '', 0o644);
    await symlink(join(root, 'elsewhere'), join(root, 'package', 'dist'));

    expect(await readActivation(root)).toEqual({
      status: 'invalid',
      reason: 'activation: package bin directory is unsafe',
    });
  });
});
