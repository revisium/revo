import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { acquireAndStagePackage } from '../../src/installation/package-stage.js';
import { packageArtifactScenario } from '../support/installation/package-artifact-scenario.js';

describe('package workspace validation', () => {
  it.each([
    ['unqualified', '  koffi: true\n'],
    ['range', '  koffi@^3.2.1: true\n'],
    ['quoted boolean', '  koffi@3.2.1: "true"\n'],
    ['mixed map and list', '  koffi@3.2.1: true\n  - sharp@0.35.1\n'],
  ])('rejects %s enabled build scripts', async (_name, entry) => {
    const data = await packageArtifactScenario({
      workspace: `packages:\n  - packages/*\nallowBuilds:\n${entry}`,
    });
    try {
      await expect(
        acquireAndStagePackage({ plan: data.plan, scratch: data.scratch, request: data.request }),
      ).rejects.toThrow('workspace allowBuilds');
    } finally {
      await data.cleanup();
    }
  });

  it('accepts exact enabled and denied build entries unchanged', async () => {
    const workspace = 'packages:\n  - packages/*\nallowBuilds:\n  koffi@3.2.1: true\n  sharp: false\n';
    const data = await packageArtifactScenario({ workspace });
    try {
      const stage = await acquireAndStagePackage({ plan: data.plan, scratch: data.scratch, request: data.request });
      expect(await readFile(stage.pnpmWorkspacePath, 'utf8')).toBe(workspace);
    } finally {
      await data.cleanup();
    }
  });

  it('accepts scoped prerelease selectors without rewriting bytes', async () => {
    const workspace = 'packages:\n  - packages/*\nallowBuilds:\n  "@embedded-postgres/linux-arm64@17.10.0-beta.17": true\n  sharp: false\n';
    const data = await packageArtifactScenario({ workspace });
    try {
      const stage = await acquireAndStagePackage({ plan: data.plan, scratch: data.scratch, request: data.request });
      expect(await readFile(stage.pnpmWorkspacePath, 'utf8')).toBe(workspace);
    } finally {
      await data.cleanup();
    }
  });

  it('rejects duplicate decoded allowBuilds keys', async () => {
    const data = await packageArtifactScenario({
      workspace: 'packages:\n  - packages/*\nallowBuilds:\n  koffi@3.2.1: true\n  "koffi@3.2.1": false\n',
    });
    try {
      await expect(acquireAndStagePackage({ plan: data.plan, scratch: data.scratch, request: data.request })).rejects.toThrow('workspace allowBuilds');
    } finally {
      await data.cleanup();
    }
  });

  it('accepts a valid top-level field after the allowBuilds block', async () => {
    const workspace = 'packages:\n  - packages/*\nallowBuilds:\n  koffi@3.2.1: true\n  sharp: false\nminimumReleaseAge: 0\n';
    const data = await packageArtifactScenario({ workspace });
    try {
      await expect(acquireAndStagePackage({ plan: data.plan, scratch: data.scratch, request: data.request })).resolves.toBeDefined();
    } finally {
      await data.cleanup();
    }
  });

  it('rejects duplicate top-level allowBuilds blocks', async () => {
    const data = await packageArtifactScenario({
      workspace: 'packages:\n  - packages/*\nallowBuilds:\n  koffi@3.2.1: true\nallowBuilds:\n  koffi@3.2.1: true\n',
    });
    try {
      await expect(acquireAndStagePackage({ plan: data.plan, scratch: data.scratch, request: data.request })).rejects.toThrow('workspace allowBuilds');
    } finally {
      await data.cleanup();
    }
  });
});
