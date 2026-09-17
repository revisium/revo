import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { acquireAndStagePackage } from '../../src/installation/package-stage.js';
import { packageArtifactScenario } from '../support/installation/package-artifact-scenario.js';

describe('package workspace validation', () => {
  const prefix = 'packages:\n  - packages/*\nallowBuilds:\n';
  const stageWorkspace = async (workspace: string) => {
    const data = await packageArtifactScenario({ workspace });
    try {
      const staged = await acquireAndStagePackage(data);
      return await readFile(staged.pnpmWorkspacePath, 'utf8');
    } finally {
      await data.cleanup();
    }
  };

  it.each([
    ['unqualified', '  koffi: true\n'],
    ['range', '  koffi@^3.2.1: true\n'],
    ['quoted boolean', '  koffi@3.2.1: "true"\n'],
    ['mixed map and list', '  koffi@3.2.1: true\n  - sharp@0.35.1\n'],
    ['duplicate decoded key', '  koffi@3.2.1: true\n  "koffi@3.2.1": false\n'],
    ['duplicate top-level block', '  koffi@3.2.1: true\nallowBuilds:\n  koffi@3.2.1: true\n'],
  ])('rejects %s enabled build scripts', async (_name, entry) => {
    await expect(stageWorkspace(prefix + entry)).rejects.toThrow('workspace allowBuilds');
  });

  it.each([
    ['exact entries', '  koffi@3.2.1: true\n  sharp: false\n'],
    [
      'scoped prerelease',
      '  "@embedded-postgres/linux-arm64@17.10.0-beta.17": true\n  sharp: false\n',
    ],
    ['top-level boundary', '  koffi@3.2.1: true\n  sharp: false\nminimumReleaseAge: 0\n'],
  ])('accepts %s without rewriting bytes', async (_name, entry) => {
    expect(await stageWorkspace(prefix + entry)).toBe(prefix + entry);
  });
});
