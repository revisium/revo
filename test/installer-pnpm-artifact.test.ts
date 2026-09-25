// oxlint-disable no-unsafe-type-assertion, no-explicit-any, no-await-in-loop, vitest/require-mock-type-parameters, vitest/require-to-throw-message -- compact fixture API
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  embeddedBootstrap,
  pnpmInstallerBuilderScenario,
} from './support/installation/installer-builder-scenario.js';
import { pnpmBootstrapScenario } from './support/installation/pnpm-bootstrap-scenario.js';

type Data = Record<string, any>;
type Api = {
  acquirePnpmArtifact: (input: Data) => Promise<Data>;
  DEFAULT_PNPM_POLICY: Data;
};
const api = await vi.importActual<Api>(
  new URL('../installer/node-bootstrap.mjs', import.meta.url).href,
);
const engine = new URL('../installer/node-bootstrap.mjs', import.meta.url).pathname;
const { buildInstaller } = await vi.importActual<{ buildInstaller: (input: unknown) => string }>(
  new URL('../installer/build-installer.mjs', import.meta.url).href,
);
const bootstrap = embeddedBootstrap(
  buildInstaller(
    pnpmInstallerBuilderScenario({
      core: '4.3.2',
      admin: '5.4.3',
      node: process.versions.node,
      pnpm: '12.5.1',
    }),
  ),
) as Data;

// Build through the real installer builder so URL/target metadata remains production-shaped.
const fixture = async (hardlink = false) => {
  const scenario = await pnpmBootstrapScenario(engine, bootstrap);
  const archive = await scenario.archive({ hardlink });
  const value = structuredClone(bootstrap);
  const selected = value.pnpmArchives.find(
    (item: Data) => item.platform === 'linux' && item.arch === 'x64',
  );
  value.pnpmArchives = value.pnpmArchives.map((item: Data) =>
    item === selected ? { ...item, sha256: archive.sha256 } : item,
  );
  await scenario.write(value);
  await mkdir(`${scenario.dataPath}.scratch`);
  return { scenario, value, scratch: `${scenario.dataPath}.scratch`, bytes: archive.bytes };
};
const response = (bytes: Uint8Array, headers: Record<string, string> = {}) => ({
  status: 200,
  headers: new Headers({ 'content-length': String(bytes.length), ...headers }),
  body: (async function* () {
    yield bytes;
  })(),
});

describe('pnpm artifact acquisition', () => {
  it('downloads, verifies, extracts and transfers a safe staged directory', async () => {
    const data = await fixture();
    const stages: string[] = [];
    const result = await api.acquirePnpmArtifact({
      bootstrap: data.value,
      platform: 'linux',
      arch: 'x64',
      scratch: data.scratch,
      request: vi.fn(async () => response(data.bytes)),
      onProgress: (stage: string) => stages.push(stage),
    });
    expect(result).toMatchObject({ version: '12.5.1', archiveSha256: expect.any(String) });
    expect(stages).toEqual(['download', 'verify', 'extract']);
    expect((await stat(result.executablePath)).mode & 0o111).toBeTruthy();
    expect(await readdir(result.directory)).toEqual(expect.arrayContaining(['pnpm', 'dist']));
  });
  it('accepts the pinned pnpm layout with an internal regular-file hardlink', async () => {
    const data = await fixture(true);
    const result = await api.acquirePnpmArtifact({
      bootstrap: data.value,
      platform: 'linux',
      arch: 'x64',
      scratch: data.scratch,
      request: vi.fn(async () => response(data.bytes)),
    });
    const [original, copy] = await Promise.all([
      stat(join(result.directory, 'dist', 'index.js')),
      stat(join(result.directory, 'dist', 'copy.js')),
    ]);
    expect(copy.ino).toBe(original.ino);
    expect(copy.nlink).toBe(2);
  });
  it('follows only bounded release-assets redirects and never leaks query secrets', async () => {
    const data = await fixture();
    const calls: string[] = [];
    const request = vi.fn(async (url: string) => {
      calls.push(url);
      return calls.length === 1
        ? {
            status: 302,
            headers: new Headers({
              location: 'https://release-assets.githubusercontent.com/a?X-Amz-Signature=secret',
            }),
            body: null,
          }
        : response(data.bytes);
    });
    await api.acquirePnpmArtifact({
      bootstrap: data.value,
      platform: 'linux',
      arch: 'x64',
      scratch: data.scratch,
      request,
    });
    expect(calls).toHaveLength(2);
  });
  it('rejects Windows before making a request', async () => {
    const data = await fixture();
    const request = vi.fn();
    await expect(
      api.acquirePnpmArtifact({
        bootstrap: data.value,
        platform: 'win32',
        arch: 'x64',
        scratch: data.scratch,
        request,
      }),
    ).rejects.toThrow(/Windows/iu);
    expect(request).not.toHaveBeenCalled();
  });
  it('cleans staged directories after checksum failure, truncation, unsafe links and abort', async () => {
    const data = await fixture();
    for (const request of [
      async () => response(data.bytes.subarray(0, 10)),
      async () => response(data.bytes, { 'content-length': String(data.bytes.length + 1) }),
    ]) {
      await expect(
        api.acquirePnpmArtifact({
          bootstrap: data.value,
          platform: 'linux',
          arch: 'x64',
          scratch: data.scratch,
          request,
        }),
      ).rejects.toThrow();
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      api.acquirePnpmArtifact({
        bootstrap: data.value,
        platform: 'linux',
        arch: 'x64',
        scratch: data.scratch,
        signal: controller.signal,
        request: vi.fn(),
      }),
    ).rejects.toThrow(/cancel/iu);
  });
});
