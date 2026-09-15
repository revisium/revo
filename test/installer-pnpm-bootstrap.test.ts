// oxlint-disable no-unsafe-type-assertion, no-explicit-any, vitest/require-mock-type-parameters -- compact installer scenario
import { mkdir, readFile, readdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  embeddedBootstrap,
  pnpmInstallerBuilderScenario,
} from './support/installation/installer-builder-scenario.js';
import { pnpmBootstrapScenario } from './support/installation/pnpm-bootstrap-scenario.js';

type Data = Record<string, any>;
type Api = {
  provisionPnpm: (input: Data) => Promise<Data>;
  PNPM_PROGRESS_STAGES: readonly string[];
};
const api = await vi.importActual<Api>(
  new URL('../installer/node-bootstrap.mjs', import.meta.url).href,
);
const engine = new URL('../installer/node-bootstrap.mjs', import.meta.url).pathname;
const { buildInstaller } = await vi.importActual<{ buildInstaller: (input: unknown) => string }>(
  new URL('../installer/build-installer.mjs', import.meta.url).href,
);
const base = embeddedBootstrap(
  buildInstaller(
    pnpmInstallerBuilderScenario({
      core: '4.3.2',
      admin: '5.4.3',
      node: process.versions.node,
      pnpm: '12.4.1',
    }),
  ),
) as Data;

const fixture = async () => {
  const scenario = await pnpmBootstrapScenario(engine, base);
  const archive = await scenario.archive();
  const value = structuredClone(base);
  const selected = value.pnpmArchives.find(
    (item: Data) => item.platform === 'linux' && item.arch === 'x64',
  );
  value.pnpmArchives = value.pnpmArchives.map((item: Data) =>
    item === selected ? { ...item, sha256: archive.sha256 } : item,
  );
  await scenario.write(value);
  await mkdir(join(scenario.root, 'channel'));
  return { scenario, value, archive, channelRoot: join(scenario.root, 'channel') };
};
const request = (bytes: Uint8Array) =>
  vi.fn(async () => ({
    status: 200,
    headers: new Headers({ 'content-length': String(bytes.length) }),
    body: (async function* () {
      yield bytes;
    })(),
  }));
const target = (root: string) =>
  join(root, 'channel', 'pnpm', process.versions.node, 'linux-x64', '12.4.1');

describe('managed pnpm bootstrap target', () => {
  it('publishes verified pnpm atomically with exact receipt and progress', async () => {
    const data = await fixture();
    const stages: string[] = [];
    const result = await api.provisionPnpm({
      bootstrap: data.value,
      nodeExecutable: data.scenario.nodeExecutable,
      channelRoot: data.channelRoot,
      scratch: data.scenario.root,
      platform: 'linux',
      arch: 'x64',
      request: request(data.archive.bytes),
      onProgress: (stage: string) => stages.push(stage),
    });
    expect(result).toEqual({
      executablePath: join(target(data.scenario.root), 'pnpm'),
      version: '12.4.1',
      reused: false,
    });
    expect(stages).toEqual(['validate', 'download', 'verify', 'extract', 'probe', 'publish']);
    expect(await readFile(join(target(data.scenario.root), 'install-receipt.json'), 'utf8')).toBe(
      `${JSON.stringify({ schemaVersion: 'revo-pnpm-bootstrap/v1', version: '12.4.1', nodeVersion: process.versions.node, platform: 'linux', arch: 'x64', archiveSha256: data.archive.sha256 })}\n`,
    );
    expect(
      (await stat(join(target(data.scenario.root), 'install-receipt.json'))).mode & 0o777,
    ).toBe(0o600);
  });
  it('probes and reuses a compatible target without downloading', async () => {
    const data = await fixture();
    const first = await api.provisionPnpm({
      bootstrap: data.value,
      nodeExecutable: data.scenario.nodeExecutable,
      channelRoot: data.channelRoot,
      scratch: data.scenario.root,
      platform: 'linux',
      arch: 'x64',
      request: request(data.archive.bytes),
    });
    const stages: string[] = [];
    const requestAgain = request(data.archive.bytes);
    const reused = await api.provisionPnpm({
      bootstrap: data.value,
      nodeExecutable: data.scenario.nodeExecutable,
      channelRoot: data.channelRoot,
      scratch: data.scenario.root,
      platform: 'linux',
      arch: 'x64',
      request: requestAgain,
      onProgress: (stage: string) => stages.push(stage),
    });
    expect(first.reused).toBe(false);
    expect(reused.reused).toBe(true);
    expect(requestAgain).not.toHaveBeenCalled();
    expect(stages).toEqual(['validate', 'probe', 'reuse']);
  });
  it('fails closed before request for Windows', async () => {
    const data = await fixture();
    const req = request(data.archive.bytes);
    await expect(
      api.provisionPnpm({
        bootstrap: data.value,
        nodeExecutable: data.scenario.nodeExecutable,
        channelRoot: data.channelRoot,
        scratch: data.scenario.root,
        platform: 'win32',
        arch: 'x64',
        request: req,
      }),
    ).rejects.toThrow(/Windows|unsupported/iu);
    expect(req).not.toHaveBeenCalled();
  });
  it('rejects unsafe ancestors, incompatible receipt and target races without touching unrelated data', async () => {
    const data = await fixture();
    const unsafe = join(data.scenario.root, 'unsafe');
    await symlink('/tmp', unsafe);
    await expect(
      api.provisionPnpm({
        bootstrap: data.value,
        nodeExecutable: data.scenario.nodeExecutable,
        channelRoot: unsafe,
        scratch: data.scenario.root,
        platform: 'linux',
        arch: 'x64',
        request: request(data.archive.bytes),
      }),
    ).rejects.toThrow(/channel|target|unsafe/iu);
    expect(await readdir(data.channelRoot)).toEqual([]);
  });
  it('exposes the finite progress contract', () =>
    expect(api.PNPM_PROGRESS_STAGES).toEqual([
      'validate',
      'download',
      'verify',
      'extract',
      'probe',
      'publish',
      'reuse',
    ]));
});
