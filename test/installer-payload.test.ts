// oxlint-disable curly -- narrow builder fixture

import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import {
  embeddedPayload,
  pnpmInstallerBuilderScenario,
} from './support/installation/installer-builder-scenario.js';

const builder = new URL('../installer/build-installer.mjs', import.meta.url).href;
const payloadBuilder = new URL('../installer/build-payload.mjs', import.meta.url).href;
const installerApi = await vi.importActual<{ buildInstaller(input: unknown): string }>(builder);
const payloadApi = await vi.importActual<{ buildPayload(): Promise<string> }>(payloadBuilder);
const buildInstaller = (input: unknown): string => installerApi.buildInstaller(input);
const buildPayload = (): Promise<string> => payloadApi.buildPayload();

describe('self-contained bootstrap payload', () => {
  it('bundles the new entry as one ESM file with only node builtins external', async () => {
    const code = await buildPayload();
    expect(code).toContain('runBootstrap');
    expect(code).not.toMatch(
      /\b(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*(?:node-bootstrap\.mjs|src\/|dist\/)/u,
    );
    for (const match of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu))
      expect(match[1]).toMatch(/^node:/u);
    for (const match of code.matchAll(/\bimport\s+['"]([^'"]+)['"]/gu))
      expect(match[1]).toMatch(/^node:/u);
  });

  it('keeps the package envelope separate from the Node v1 bootstrap data', () => {
    const input = pnpmInstallerBuilderScenario();
    const payload = embeddedPayload(buildInstaller(input));
    expect(payload).toContain('revo-package-install/v1');
    expect(payload).toContain(input.manifest.artifacts.package.url);
    expect(payload).toContain(input.manifest.toolchain.pnpm);
  });
});
