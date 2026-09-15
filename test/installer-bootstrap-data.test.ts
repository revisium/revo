// oxlint-disable curly, no-unsafe-type-assertion, vitest/no-conditional-expect -- fixture DSL keeps malformed cases narrow

import { describe, expect, it, vi } from 'vitest';

import {
  embeddedBootstrap,
  installerBuilderScenario,
  pnpmInstallerBuilderScenario,
} from './support/installation/installer-builder-scenario.js';
import { pnpmBootstrapScenario } from './support/installation/pnpm-bootstrap-scenario.js';
const enginePath = new URL('../installer/node-bootstrap.mjs', import.meta.url).pathname;
type Data = Record<string, unknown>;
type Decoded = Data & { nodeArchive: Data; pnpmArchive: Data | undefined };
type Api = {
  readonly decodeBootstrap: (value: unknown, options: Data) => Decoded;
  readonly runBootstrap: (input: Data) => Promise<unknown>;
};
const api = await vi.importActual<Api>(
  new URL('../installer/node-bootstrap.mjs', import.meta.url).href,
);
const { buildInstaller } = await vi.importActual<{ buildInstaller: (input: unknown) => string }>(
  new URL('../installer/build-installer.mjs', import.meta.url).href,
);
const targets = [
  ['darwin', 'arm64', 'tar.gz'],
  ['darwin', 'x64', 'tar.gz'],
  ['linux', 'arm64', 'tar.xz'],
  ['linux', 'x64', 'tar.xz'],
  ['win32', 'arm64', 'zip'],
  ['win32', 'x64', 'zip'],
] as const;
const build = (v3: boolean): Data => {
  const versions = { core: '4.3.2', admin: '5.4.3', node: process.versions.node, pnpm: '13.0.2' };
  return embeddedBootstrap(
    buildInstaller(
      v3 ? pnpmInstallerBuilderScenario(versions) : installerBuilderScenario(versions),
    ),
  ) as Data;
};
const copy = <T>(value: T): T => structuredClone(value);
const nodeArchives = (value: Data) => value.archives as Data[];
const archive = (value: Data) =>
  nodeArchives(value).find((item) => item.platform === 'linux' && item.arch === 'x64') as Data & {
    sha256: string;
  };
const malformed = (kind: string, value: Data): Data => {
  const next = copy(value),
    archives = nodeArchives(next);
  if (kind === 'checksum') archives[0] = { ...archives[0], sha256: 'bad' };
  if (kind === 'duplicate') archives[1] = { ...archives[0] };
  if (kind === 'unknown') archives[0] = { ...archives[0], trust: true };
  if (kind === 'URL') {
    const pnpmArchives = next.pnpmArchives as Data[];
    pnpmArchives[0] = { ...pnpmArchives[0], url: 'https://mirror.invalid/pnpm.tar.gz' };
  }
  return next;
};
describe('installer bootstrap decoder and Node receipt runner', () => {
  it.each([false, true])('decodes actual builder v%s data for every platform', (v3) => {
    const value = build(v3);
    for (const [platform, arch, format] of targets) {
      const decoded = api.decodeBootstrap(value, {
        platform,
        arch,
        nodeVersion: process.versions.node,
      });
      expect(decoded.nodeArchive).toMatchObject({ platform, arch, format });
      expect(decoded.pnpmArchive).toEqual(
        v3
          ? expect.objectContaining({
              platform,
              arch,
              format: platform === 'win32' ? 'zip' : 'tar.gz',
            })
          : undefined,
      );
    }
  });
  it.each([
    ['selected checksum', (value: Data) => value, '0'.repeat(64)],
    ['runtime version', (value: Data) => ({ ...value, nodeVersion: '26.8.1' }), undefined],
    ['input', undefined, undefined],
  ] as const)('does not write a receipt for bad %s', async (_name, mutate, checksum) => {
    const value = build(false);
    const scenario = await pnpmBootstrapScenario(enginePath, value);
    await scenario.write(mutate?.(value) ?? value);
    await expect(
      api.runBootstrap({
        dataPath: _name === 'input' ? `${scenario.dataPath}.missing` : scenario.dataPath,
        receiptPath: scenario.receiptPath,
        target: 'linux-x64',
        archiveSha256: checksum ?? archive(value)?.sha256 ?? '',
      }),
    ).rejects.toThrow(/bootstrap|input|checksum|version/iu);
    expect(await scenario.receipt()).toBeUndefined();
  });
  it.each(['checksum', 'duplicate', 'unknown', 'URL'])('rejects bad %s descriptor in v3', (kind) =>
    expect(() =>
      api.decodeBootstrap(malformed(kind, build(true)), {
        platform: 'linux',
        arch: 'x64',
        nodeVersion: process.versions.node,
      }),
    ).toThrow(/bootstrap|descriptor|target|URL/iu),
  );
  it('keeps import inert, performs no pnpm work, and writes exact 0600 receipt', async () => {
    const value = build(true);
    const selected = archive(value);
    const scenario = await pnpmBootstrapScenario(enginePath, value);
    expect(await scenario.runDirect('linux-x64', selected.sha256)).toEqual({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
    });
    expect(await scenario.receipt()).toBe(
      `${JSON.stringify({ version: process.versions.node, target: 'linux-x64', archiveSha256: selected.sha256 })}\n`,
    );
    expect(await scenario.receiptMode()).toBe(0o600);
  });
  it('never overwrites an existing receipt', async () => {
    const value = build(false);
    const selected = archive(value);
    const scenario = await pnpmBootstrapScenario(enginePath, value);
    expect((await scenario.runDirect('linux-x64', selected.sha256)).code).toBe(0);
    const before = await scenario.receipt();
    expect((await scenario.runDirect('linux-x64', selected.sha256)).code).not.toBe(0);
    expect(await scenario.receipt()).toBe(before);
  });
});
