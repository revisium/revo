// oxlint-disable no-explicit-any, no-unsafe-type-assertion, vitest/require-mock-type-parameters -- compact installer scenarios
import { readdir, realpath, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  embeddedBootstrap,
  installerBuilderScenario,
  pnpmInstallerBuilderScenario,
} from './support/installation/installer-builder-scenario.js';
import { pnpmBootstrapScenario } from './support/installation/pnpm-bootstrap-scenario.js';

type Data = Record<string, any>;
type Api = {
  runInstallMode: (input: Data) => Promise<Data>;
};
const api = await vi.importActual<Api>(
  new URL('../installer/node-bootstrap.mjs', import.meta.url).href,
);
const engine = new URL('../installer/node-bootstrap.mjs', import.meta.url).pathname;
const { buildInstaller } = await vi.importActual<{ buildInstaller: (input: unknown) => string }>(
  new URL('../installer/build-installer.mjs', import.meta.url).href,
);
const versions = { core: '4.3.2', admin: '5.4.3', node: process.versions.node, pnpm: '12.4.1' };
const build = (v3: boolean) =>
  embeddedBootstrap(
    buildInstaller(
      v3 ? pnpmInstallerBuilderScenario(versions) : installerBuilderScenario(versions),
    ),
  ) as Data;
const selected = (value: Data) =>
  value.pnpmArchives?.find((item: Data) => item.platform === 'linux' && item.arch === 'x64');
const fixture = async (v3 = true) => {
  const value = build(v3);
  const scenario = await pnpmBootstrapScenario(engine, value);
  const archive = await scenario.archive();
  if (v3) {
    const item = selected(value);
    value.pnpmArchives = value.pnpmArchives.map((entry: Data) =>
      entry === item ? { ...entry, sha256: archive.sha256 } : entry,
    );
    await scenario.write(value);
  }
  const channelRoot = join(scenario.root, 'channel');
  await mkdir(channelRoot);
  return { value, scenario, archive, channelRoot };
};
const input = async (data: Data) => ({
  dataPath: data.scenario.dataPath,
  receiptPath: data.scenario.receiptPath,
  target: 'linux-x64',
  archiveSha256: data.value.archives.find(
    (item: Data) => item.platform === 'linux' && item.arch === 'x64',
  ).sha256,
  channelRoot: data.channelRoot,
  privateNodeRoot: dirname(await realpath(process.execPath)),
  scratch: data.scenario.root,
  request: vi.fn(async () => ({
    status: 200,
    headers: new Headers({ 'content-length': String(data.archive.bytes.length) }),
    body: (async function* () {
      yield data.archive.bytes;
    })(),
  })),
});

describe('toolchain runtime handoff', () => {
  it('uses the executing private Node to publish v3 pnpm and writes the Node receipt', async () => {
    const data = await fixture();
    const options = await input(data);
    const result = await api.runInstallMode(options);
    expect(result).toMatchObject({
      version: '12.4.1',
      reused: false,
      nodeExecutable: process.execPath,
    });
    expect(await data.scenario.receipt()).toContain('"target":"linux-x64"');
    expect(options.request).toHaveBeenCalledTimes(1);
  });
  it('reuses the managed target without a second acquisition', async () => {
    const data = await fixture();
    const first = await input(data);
    await api.runInstallMode(first);
    const second = await input(data);
    const result = await api.runInstallMode(second);
    expect(result.reused).toBe(true);
    expect(second.request).not.toHaveBeenCalled();
  });
  it.each(['legacy v2', 'missing private Node root'])(
    'fails closed before pnpm work for %s',
    async (kind) => {
      const data = await fixture(kind !== 'legacy v2');
      const options = await input(data);
      if (kind === 'missing private Node root') {
        options.privateNodeRoot = join(data.scenario.root, 'elsewhere');
      }
      await expect(api.runInstallMode(options)).rejects.toThrow(/v3|private|root|incomplete/iu);
      expect(options.request).not.toHaveBeenCalled();
      expect(await data.scenario.receipt()).toBeUndefined();
    },
  );
  it('rejects partial handoff inputs without reading or publishing', async () => {
    const data = await fixture();
    const options = await input(data);
    delete options.scratch;
    await expect(api.runInstallMode(options)).rejects.toThrow(/incomplete/iu);
    expect(options.request).not.toHaveBeenCalled();
  });
  it('reports probe failures by stage and removes the owned acquired stage', async () => {
    const data = await fixture();
    data.value.pnpmVersion = '12.4.2';
    data.value.pnpmArchives = data.value.pnpmArchives.map((entry: Data) => ({
      ...entry,
      url: entry.url.replace('/v12.4.1/', '/v12.4.2/'),
      ...(entry.platform === 'linux' && entry.arch === 'x64'
        ? { sha256: data.archive.sha256 }
        : {}),
    }));
    await data.scenario.write(data.value);
    const options = await input(data);
    await expect(api.runInstallMode(options)).rejects.toThrow(/pnpm probe/iu);
    expect(await readdir(data.scenario.root)).not.toContain(
      expect.stringMatching(/^\.pnpm-stage-/u),
    );
  });
});
