import { describe, expect, it, vi } from 'vitest';

import {
  INSTALLER_DATA_SLOT,
  INSTALLER_DATA_DELIMITER,
  INSTALLER_PAYLOAD_DELIMITER,
  INSTALLER_PAYLOAD_SLOT,
  INSTALLER_POSIX_SLOT,
  archiveAt,
  bootstrapPolicy,
  embeddedBootstrap,
  embeddedPayload,
  expectedBootstrap,
  installerBuilderScenario,
  withArchives,
} from './support/installation/installer-builder-scenario.js';
import {
  futureReleasePolicyFixture,
  type NodeArchiveFixture,
} from './support/installation/release-manifest-fixture.js';

interface InstallerBuilder {
  readonly buildInstaller: (input: unknown) => string;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error('embedded bootstrap was not an object');
  }
  return value;
};
const records = (value: unknown): readonly Record<string, unknown>[] => {
  if (!Array.isArray(value)) {
    throw new Error('embedded bootstrap archives were not an array');
  }
  return value.map(record);
};
const builderUrl = new URL('../installer/build-installer.mjs', import.meta.url).href;
const { buildInstaller } = await vi.importActual<InstallerBuilder>(builderUrl);
const build = (input: unknown = installerBuilderScenario()): string => buildInstaller(input);
describe('programmatic installer builder', () => {
  it('composes a deterministic installer from explicit template and payload inputs', () => {
    const input = installerBuilderScenario();
    const first = build(input);
    const second = build(input);
    expect(first).toBe(second);
    expect(first).toMatch(/^#!\/bin\/sh\n/u);
    expect(first).not.toContain(INSTALLER_DATA_SLOT);
    expect(first).not.toContain(INSTALLER_PAYLOAD_SLOT);
    expect(first).not.toContain(INSTALLER_POSIX_SLOT);
    expect(first).not.toMatch(/revo-(?:lab|fixture|test)-/iu);
    expect(first).not.toMatch(/base64|openssl/iu);
    expect(embeddedPayload(first)).toBe(input.payload);
  });
  it('embeds the validated generic release values and six canonical descriptors', () => {
    const input = installerBuilderScenario({
      core: '8.7.6-beta.2',
      admin: '9.8.7+build.4',
      node: '30.0.0-rc.1',
      pnpm: '14.2.1',
    });
    const actual = embeddedBootstrap(build(input));
    expect(actual).toEqual(expectedBootstrap(input));
    const archives = records(record(actual).archives);
    expect(archives).toHaveLength(6);
    expect(
      archives.map(
        ({ platform, arch, format }) => `${String(platform)}/${String(arch)}/${String(format)}`,
      ),
    ).toEqual([
      'darwin/arm64/tar.gz',
      'darwin/x64/tar.gz',
      'linux/arm64/tar.xz',
      'linux/x64/tar.xz',
      'win32/arm64/zip',
      'win32/x64/zip',
    ]);
    for (const descriptor of archives) {
      expect(Object.keys(descriptor).sort()).toEqual([
        'arch',
        'format',
        'platform',
        'sha256',
        'url',
      ]);
    }
  });
  it('canonicalizes a valid permutation instead of trusting manifest order', () => {
    const input = installerBuilderScenario();
    const permuted = withArchives(input, (archives) => [
      archiveAt(archives, 3),
      archiveAt(archives, 0),
      archiveAt(archives, 5),
      archiveAt(archives, 2),
      archiveAt(archives, 1),
      archiveAt(archives, 4),
    ]);
    expect(build(permuted)).toBe(build(input));
    expect(embeddedBootstrap(build(permuted))).toEqual(expectedBootstrap(input));
  });
  it.each([
    ['manifest', undefined],
    ['manifest', null],
    ['policy', []],
    ['bootstrapPolicy', 'trusted'],
    ['template', 7],
    ['payload', {}],
  ] as const)('rejects missing or malformed runtime %s input', (field, value) => {
    const input: Record<string, unknown> = { ...installerBuilderScenario(), [field]: value };
    const expected =
      field === 'bootstrapPolicy' ? /bootstrap[ -]?policy/iu : new RegExp(field, 'iu');
    expect(() => buildInstaller(input)).toThrow(expected);
  });
  it('validates the manifest against trusted release policy', () => {
    const input = installerBuilderScenario();
    const foreignPolicy = futureReleasePolicyFixture({
      distributionRoot: 'https://foreign.example',
      registryRoot: 'https://registry.foreign.example',
      supportedSchemaVersions: ['revo-install/v2'],
    });
    expect(() => build({ ...input, policy: foreignPolicy })).toThrow(/policy|url|origin/iu);
    expect(() =>
      build({
        ...input,
        manifest: { ...input.manifest, schemaVersion: 'revo-install/v1' },
      }),
    ).toThrow(/schema|version/iu);
  });
  it.each([
    ['missing target', (archives: readonly NodeArchiveFixture[]) => archives.slice(1)],
    [
      'duplicate target',
      (archives: readonly NodeArchiveFixture[]) => [archiveAt(archives, 0), ...archives],
    ],
    [
      'invalid hash',
      (archives: readonly NodeArchiveFixture[]) => [
        { ...archiveAt(archives, 0), sha256: 'not-a-sha256' },
        ...archives.slice(1),
      ],
    ],
    [
      'policy URL mismatch',
      (archives: readonly NodeArchiveFixture[]) => [
        { ...archiveAt(archives, 0), url: 'https://foreign.example/node.tar.xz' },
        ...archives.slice(1),
      ],
    ],
  ] as const)('rejects %s archive data', (_name, mutate) => {
    const input = installerBuilderScenario();
    expect(() => build(withArchives(input, mutate))).toThrow(/archive|target|hash|url|policy/iu);
  });
  it('rejects unknown manifest and bootstrap policy fields', () => {
    const input = installerBuilderScenario();
    const archive = archiveAt(input.manifest.toolchain.nodeArchives, 0);
    const unknownDescriptor: unknown = {
      ...input,
      manifest: {
        ...input.manifest,
        toolchain: {
          ...input.manifest.toolchain,
          nodeArchives: [
            { ...archive, mirror: 'untrusted' },
            ...input.manifest.toolchain.nodeArchives.slice(1),
          ],
        },
      },
    };
    const unknownPolicy = { ...bootstrapPolicy, retryLimit: 3 };
    const unknownManifest = { ...input.manifest, trusted: true };
    expect(() => build(unknownDescriptor)).toThrow(/archive|unknown|field/iu);
    expect(() => buildInstaller({ ...input, manifest: unknownManifest })).toThrow(
      /manifest|schema|unknown/iu,
    );
    expect(() => buildInstaller({ ...input, bootstrapPolicy: unknownPolicy })).toThrow(
      /bootstrap|policy|unknown/iu,
    );
  });
  it('rejects malformed bootstrap policy instead of deriving trust from manifest input', () => {
    const input = installerBuilderScenario();
    const missingTarget = {
      ...bootstrapPolicy,
      targets: bootstrapPolicy.targets.slice(1),
    };
    const invalidFormat = {
      ...bootstrapPolicy,
      targets: [
        { ...bootstrapPolicy.targets[0], format: 'tgz' },
        ...bootstrapPolicy.targets.slice(1),
      ],
    };
    const invalidPolicies = [
      ['missing target', missingTarget],
      ['invalid format', invalidFormat],
      ['unsupported schema', { ...bootstrapPolicy, schemaVersion: 'revo-node-bootstrap/v2' }],
      ['malformed schema', { ...bootstrapPolicy, schemaVersion: 1 }],
    ] as const;
    for (const [, policy] of invalidPolicies) {
      expect(() => buildInstaller({ ...input, bootstrapPolicy: policy })).toThrow(
        /bootstrap|policy|target|format|schema|version/iu,
      );
    }
  });
  it('requires explicit positive integer execution budgets', () => {
    const input = installerBuilderScenario();
    const fields = [
      'downloadTimeoutSeconds',
      'nodeProbeTimeoutSeconds',
      'payloadTimeoutSeconds',
      'terminationGraceSeconds',
    ] as const;
    for (const field of fields) {
      const missing = { ...input.bootstrapPolicy } as Record<string, unknown>;
      delete missing[field];
      expect(() => build({ ...input, bootstrapPolicy: missing })).toThrow(
        /policy|duration|timeout|grace/iu,
      );
      for (const value of [0, -1, 1.5, '1', Number.POSITIVE_INFINITY]) {
        expect(() =>
          build({
            ...input,
            bootstrapPolicy: { ...input.bootstrapPolicy, [field]: value },
          }),
        ).toThrow(/policy|duration|timeout|grace/iu);
      }
    }
  });
  it('renders generic execution budgets and safely quoted POSIX descriptors', () => {
    const input = installerBuilderScenario();
    const policy = {
      ...input.bootstrapPolicy,
      downloadTimeoutSeconds: 41,
      nodeProbeTimeoutSeconds: 17,
      payloadTimeoutSeconds: 131,
      terminationGraceSeconds: 7,
    };
    const installer = build({ ...input, bootstrapPolicy: policy });
    expect(record(embeddedBootstrap(installer)).execution).toEqual({
      downloadTimeoutSeconds: 41,
      nodeProbeTimeoutSeconds: 17,
      payloadTimeoutSeconds: 131,
      terminationGraceSeconds: 7,
    });
    expect(installer).toContain('darwin/arm64/tar.gz');
    expect(installer).toContain('linux/x64/tar.xz');
    expect(installer).not.toContain('win32/x64/zip)');
  });
  it('preserves hostile payload bytes in the literal block', () => {
    const input = installerBuilderScenario();
    const injection = "'\"$()`; $$ $& $` $' touch /tmp/revo-builder-must-not-run #";
    const payload = `${input.payload}\n// ${injection}\n`;
    const installer = build({ ...input, payload });
    expect(embeddedPayload(installer)).toBe(payload);
    expect(record(embeddedBootstrap(installer)).nodeVersion).toBe(input.manifest.toolchain.node);
  });
  it('rejects missing, duplicated, or unresolved composition slots', () => {
    const input = installerBuilderScenario();
    const slotCases = [
      ['missing data', input.template.replace(INSTALLER_DATA_SLOT, '')],
      ['missing payload', input.template.replace(INSTALLER_PAYLOAD_SLOT, '')],
      [
        'duplicate data',
        input.template.replace(
          INSTALLER_DATA_SLOT,
          `${INSTALLER_DATA_SLOT}\n${INSTALLER_DATA_SLOT}`,
        ),
      ],
      [
        'duplicate payload',
        input.template.replace(
          INSTALLER_PAYLOAD_SLOT,
          `${INSTALLER_PAYLOAD_SLOT}\n${INSTALLER_PAYLOAD_SLOT}`,
        ),
      ],
      ['unresolved slot', `${input.template}\n@@REVO_UNRESOLVED@@\n`],
      ['missing POSIX table', input.template.replace(INSTALLER_POSIX_SLOT, '')],
      [
        'duplicate POSIX table',
        input.template.replace(
          INSTALLER_POSIX_SLOT,
          `${INSTALLER_POSIX_SLOT}\n${INSTALLER_POSIX_SLOT}`,
        ),
      ],
    ] as const;
    for (const [, template] of slotCases) {
      expect(() => build({ ...input, template })).toThrow(
        /template|data|payload|unresolved|slot/iu,
      );
    }
  });
  it.each([
    ['template data delimiter', 'template', INSTALLER_DATA_DELIMITER],
    ['template payload delimiter', 'template', INSTALLER_PAYLOAD_DELIMITER],
    ['payload delimiter', 'payload', INSTALLER_PAYLOAD_DELIMITER],
  ] as const)('rejects standalone heredoc collision in %s', (_name, source, delimiter) => {
    const input = installerBuilderScenario();
    const collision = `before\n${delimiter}\nafter`;
    const changed =
      source === 'template'
        ? { ...input, template: `${input.template}\n${collision}` }
        : { ...input, payload: `${input.payload}\n${collision}` };
    expect(() => build(changed)).toThrow(/delimiter|heredoc|collision|template|payload/iu);
  });
});
