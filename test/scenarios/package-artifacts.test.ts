// oxlint-disable vitest/require-mock-type-parameters -- bounded request doubles
import { readFile, readdir } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { acquirePackageArtifacts } from '../../src/installation/package-artifacts.js';
import { acquireAndStagePackage } from '../../src/installation/package-stage.js';
import {
  packageArtifactScenario,
  tarFixture,
} from '../support/installation/package-artifact-scenario.js';
describe('release package acquisition and staging', () => {
  it('extracts only the package root, keeps the lock verbatim, and isolates channels', async () => {
    const stable = await packageArtifactScenario({ channel: 'stable' });
    const alpha = await packageArtifactScenario({ channel: 'alpha' });
    const [stableStage, alphaStage] = await Promise.all([
      acquireAndStagePackage({
        plan: stable.plan,
        scratch: stable.scratch,
        request: stable.request,
      }),
      acquireAndStagePackage({ plan: alpha.plan, scratch: alpha.scratch, request: alpha.request }),
    ]);
    expect(stableStage.directory).not.toBe(alphaStage.directory);
    expect(await readFile(stableStage.pnpmLockPath, 'utf8')).toContain('lockfileVersion: 9.0');
    expect(await readdir(stableStage.packageDirectory)).toEqual(
      expect.arrayContaining(['package.json', 'dist', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']),
    );
    await stable.cleanup();
    await alpha.cleanup();
  });
  it.each([
    ['absolute', tarFixture({ '/package.json': '{}' })],
    ['traversal', tarFixture({ 'package/../escape': 'x' })],
    [
      'symlink',
      (() => {
        const bytes = tarFixture({ 'package/x': 'x' });
        bytes[156] = 50;
        return bytes;
      })(),
    ],
  ])('rejects unsafe %s tar entries and cleans its owned stage', async (_name, archive) => {
    const data = await packageArtifactScenario({ unsafeTar: archive });
    await expect(
      acquireAndStagePackage({ plan: data.plan, scratch: data.scratch, request: data.request }),
    ).rejects.toThrow(/package|tar|path|type/iu);
    expect(await readdir(data.scratch)).toEqual([]);
  });
  it('rejects package identity, lifecycle hooks, and unqualified build permissions', async () => {
    const data = await packageArtifactScenario();
    const bad = JSON.stringify({
      name: '@revisium/revo',
      version: data.plan.release.version,
      packageManager: 'pnpm@1.0.0',
      scripts: { install: 'touch /tmp/pwned' },
    });
    const archive = tarFixture({ 'package/': '', 'package/package.json': bad });
    const poisoned = await packageArtifactScenario({ unsafeTar: archive });
    await expect(
      acquireAndStagePackage({
        plan: poisoned.plan,
        scratch: poisoned.scratch,
        request: poisoned.request,
      }),
    ).rejects.toThrow(/package|sidecar|identity/iu);
    await data.cleanup();
    await poisoned.cleanup();
  });
  it('honours cancellation before any request and removes owned acquisition data', async () => {
    const data = await packageArtifactScenario();
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn();
    await expect(
      acquirePackageArtifacts({
        plan: data.plan,
        scratch: data.scratch,
        signal: controller.signal,
        request,
      }),
    ).rejects.toThrow(/cancel/iu);
    expect(request).not.toHaveBeenCalled();
    expect(await readdir(data.scratch)).toEqual([]);
  });
  it('fails closed for a bad selected digest and a foreign redirect', async () => {
    const data = await packageArtifactScenario();
    const badPlan = {
      ...data.plan,
      artifacts: {
        ...data.plan.artifacts,
        packageJson: { ...data.plan.artifacts.packageJson, sha256: '0'.repeat(64) },
      },
    };
    await expect(
      acquirePackageArtifacts({ plan: badPlan, scratch: data.scratch, request: data.request }),
    ).rejects.toThrow(/SHA-256/iu);
    const redirect = async () => ({
      status: 302,
      headers: new Headers({ location: 'https://evil.example/package.tgz' }),
      body: null,
    });
    await expect(
      acquirePackageArtifacts({ plan: data.plan, scratch: data.scratch, request: redirect }),
    ).rejects.toThrow(/redirect|origin/iu);
    expect(await readdir(data.scratch)).toEqual([]);
    await data.cleanup();
  });
  it('rejects failed HTTP, truncated, and bodyless responses', async () => {
    const data = await packageArtifactScenario();
    const requests = [
      async () => ({ status: 503, headers: new Headers(), body: null }),
      async () => ({
        status: 200,
        headers: new Headers({ 'content-length': '2' }),
        body: (async function* () {
          yield Uint8Array.of(1);
        })(),
      }),
      async () => ({ status: 200, headers: new Headers(), body: null }),
    ];
    await Promise.all(
      requests.map((request) =>
        expect(
          acquirePackageArtifacts({ plan: data.plan, scratch: data.scratch, request }),
        ).rejects.toThrow(/download|body|truncated|HTTP/iu),
      ),
    );
  });
  it('rejects unbounded download policy', async () => {
    const data = await packageArtifactScenario();
    await expect(
      acquirePackageArtifacts({
        plan: data.plan,
        scratch: data.scratch,
        policy: { maxDownloadBytes: 0 },
        request: data.request,
      }),
    ).rejects.toThrow(/policy|bound/iu);
  });

  it('reads bounded arrayBuffer responses', async () => {
    const data = await packageArtifactScenario();
    const request = async () => ({
      status: 200,
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => data.bytes.package,
    });
    await expect(
      acquirePackageArtifacts({ plan: data.plan, scratch: data.scratch, request }),
    ).rejects.toThrow(/SHA-256/iu);
  });
});
