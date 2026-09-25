import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { parsePreparedPackageReceipt } from '../src/installation/prepared-package.js';
import {
  embeddedPayload,
  pnpmInstallerBuilderScenario,
} from './support/installation/installer-builder-scenario.js';
import { installerPackageScenario } from './support/installation/installer-package-scenario.js';

const builder = new URL('../installer/build-installer.mjs', import.meta.url).href;
const payloadBuilder = new URL('../installer/build-payload.mjs', import.meta.url).href;
const installerApi = await vi.importActual<{ buildInstaller(input: unknown): string }>(builder);
const payloadApi = await vi.importActual<{ buildPayload(): Promise<string> }>(payloadBuilder);

describe('generated POSIX package installer', () => {
  it('carries package identities and digests in its autonomous payload', async () => {
    const input = pnpmInstallerBuilderScenario();
    const payload = await payloadApi.buildPayload();
    const installer = installerApi.buildInstaller({
      ...input,
      payload,
      template: await readFile(new URL('../installer/install.sh.in', import.meta.url), 'utf8'),
    });
    expect(embeddedPayload(installer)).toContain('revo-package-install/v1');
    expect(embeddedPayload(installer)).toContain(input.manifest.artifacts.package.sha256);
    expect(embeddedPayload(installer)).not.toContain('src/installation');
    expect(installer).toContain('revo_package_enabled=1');
  });

  it('publishes one immutable prepared target and reuses its exact receipt', async () => {
    const data = await installerPackageScenario();
    try {
      const result = await data.publish();
      expect(result.directory).toBe(data.target);
      expect(await data.mode(data.target)).toBe(0o700);
      expect(await data.mode(`${data.target}/install-receipt.json`)).toBe(0o600);
      expect(JSON.parse(await data.readReceipt())).toEqual(data.receipt);
      expect(await data.reuse()).toBe(data.target);
      await expect(data.publish()).rejects.toThrow(/stage|already exists/iu);
    } finally {
      await data.cleanup();
    }
  });

  it('fails closed on a foreign or corrupt prepared target without repair', async () => {
    const data = await installerPackageScenario();
    try {
      await data.publish();
      const targetMode = await data.mode(data.target);
      await (
        await import('node:fs/promises')
      ).writeFile(`${data.target}/install-receipt.json`, '{}\n');
      await expect(data.reuse()).rejects.toThrow(/receipt/iu);
      expect(await data.mode(data.target)).toBe(targetMode);
    } finally {
      await data.cleanup();
    }
  });

  it('rejects malformed receipt identities and digests', () => {
    const data = {
      schemaVersion: 'revo-package-prepared/v1',
      release: {},
      components: {},
      target: { platform: 'linux', arch: 'x64' },
      toolchain: { node: '26.8.2', pnpm: '12.5.1' },
      artifacts: {
        package: { sha256: '0'.repeat(64), integrity: 'sha512-x' },
        packageJson: { sha256: '0'.repeat(64) },
        pnpmLock: { sha256: '0'.repeat(64) },
        pnpmWorkspace: { sha256: '0'.repeat(64) },
      },
    };
    const malformed = [
      {},
      { ...data, target: { ...data.target, extra: true } },
      { ...data, toolchain: { node: data.toolchain.node } },
      { ...data, artifacts: { ...data.artifacts, packageJson: { sha256: 'bad' } } },
      {
        ...data,
        artifacts: { ...data.artifacts, package: { sha256: '0'.repeat(64), integrity: 'bad' } },
      },
    ];
    for (const value of malformed) {
      expect(() => parsePreparedPackageReceipt(value)).toThrow(/prepared package/iu);
    }
  });

  it('rejects unsafe package contents without repairing the target', async () => {
    const data = await installerPackageScenario();
    try {
      await data.publish();
      const packageJson = await readFile(`${data.target}/package.json`, 'utf8');
      await writeFile(
        `${data.target}/package.json`,
        packageJson.replace('@revisium/revo', 'foreign'),
      );
      await expect(data.reuse()).rejects.toThrow(/identity/iu);
      await writeFile(`${data.target}/package.json`, packageJson);
      await writeFile(`${data.target}/pnpm-lock.yaml`, 'foreign');
      await expect(data.reuse()).rejects.toThrow(/digest/iu);
    } finally {
      await data.cleanup();
    }
  });

  it('fails closed for absent, symlinked, or unsafe receipt locations', async () => {
    const absent = await installerPackageScenario();
    try {
      expect(await absent.reuse()).toBeUndefined();
      await rm(absent.stage, { recursive: true });
      await expect(absent.publish()).rejects.toThrow(/stage/iu);
    } finally {
      await absent.cleanup();
    }

    const data = await installerPackageScenario();
    try {
      await data.publish();
      await chmod(`${data.target}/install-receipt.json`, 0o644);
      await expect(data.reuse()).rejects.toThrow(/receipt/iu);
      await chmod(`${data.target}/install-receipt.json`, 0o600);
      await rm(data.target, { recursive: true });
      await symlink(data.root, data.target);
      await expect(data.reuse()).rejects.toThrow(/unsafe/iu);
    } finally {
      await data.cleanup();
    }

    const ancestor = await installerPackageScenario();
    try {
      await mkdir(`${ancestor.channelRoot}/package`);
      await writeFile(`${ancestor.channelRoot}/package/${ancestor.plan.release.version}`, 'file');
      await expect(ancestor.publish()).rejects.toThrow(/ancestor/iu);
    } finally {
      await ancestor.cleanup();
    }
  });
});
