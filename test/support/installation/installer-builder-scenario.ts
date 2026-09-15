import {
  futureReleaseManifestFixture,
  futureReleasePolicyFixture,
  type FutureReleaseManifestFixture,
  type NodeArchiveFixture,
} from './release-manifest-fixture.js';
export const INSTALLER_DATA_SLOT = '@@REVO_NODE_BOOTSTRAP_DATA@@';
export const INSTALLER_PAYLOAD_SLOT = '@@REVO_NODE_BOOTSTRAP_PAYLOAD@@';
export const INSTALLER_POSIX_SLOT = '@@REVO_POSIX_BOOTSTRAP_TABLE@@';
export const INSTALLER_DATA_DELIMITER = 'REVO_NODE_BOOTSTRAP_DATA';
export const INSTALLER_PAYLOAD_DELIMITER = 'REVO_NODE_BOOTSTRAP_PAYLOAD';
export const installerTemplate = `#!/bin/sh
set -eu
${INSTALLER_POSIX_SLOT}
# revo-node-bootstrap-data-begin
cat >"$revo_data_file" <<'${INSTALLER_DATA_DELIMITER}'
${INSTALLER_DATA_SLOT}
${INSTALLER_DATA_DELIMITER}
# revo-node-bootstrap-data-end
# revo-node-bootstrap-payload-begin
cat >"$revo_payload_file" <<'${INSTALLER_PAYLOAD_DELIMITER}'
${INSTALLER_PAYLOAD_SLOT}
${INSTALLER_PAYLOAD_DELIMITER}
# revo-node-bootstrap-payload-end
`;
export const installerPayload = `import { readFile } from 'node:fs/promises';

const bootstrap = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (bootstrap.nodeVersion !== process.versions.node) process.exitCode = 23;
`;
export const bootstrapPolicy = {
  schemaVersion: 'revo-node-bootstrap/v1',
  downloadTimeoutSeconds: 30,
  nodeProbeTimeoutSeconds: 10,
  payloadTimeoutSeconds: 120,
  terminationGraceSeconds: 5,
  targets: [
    { platform: 'darwin', arch: 'arm64', format: 'tar.gz' },
    { platform: 'darwin', arch: 'x64', format: 'tar.gz' },
    { platform: 'linux', arch: 'arm64', format: 'tar.xz' },
    { platform: 'linux', arch: 'x64', format: 'tar.xz' },
    { platform: 'win32', arch: 'arm64', format: 'zip' },
    { platform: 'win32', arch: 'x64', format: 'zip' },
  ],
} as const;
export interface InstallerBuilderInput {
  readonly manifest: FutureReleaseManifestFixture['manifest'];
  readonly policy: ReturnType<typeof futureReleasePolicyFixture>;
  readonly bootstrapPolicy: typeof bootstrapPolicy;
  readonly template: string;
  readonly payload: string;
}
export interface EmbeddedBootstrap {
  readonly schemaVersion: string;
  readonly nodeVersion: string;
  readonly execution: {
    readonly downloadTimeoutSeconds: number;
    readonly nodeProbeTimeoutSeconds: number;
    readonly payloadTimeoutSeconds: number;
    readonly terminationGraceSeconds: number;
  };
  readonly snapshot: { readonly url: string; readonly sha256: string };
  readonly archives: readonly NodeArchiveFixture[];
}
export const installerBuilderScenario = (
  versions = {
    core: '4.3.2',
    admin: '5.4.3',
    node: '28.1.0',
    pnpm: '13.0.2',
  },
): InstallerBuilderInput => {
  const policy = futureReleasePolicyFixture({ supportedSchemaVersions: ['revo-install/v2'] });
  const fixture = futureReleaseManifestFixture({ version: '2.7.1', versions, policy });
  return {
    manifest: fixture.manifest,
    policy,
    bootstrapPolicy,
    template: installerTemplate,
    payload: installerPayload,
  };
};
const literalBlock = (installer: string, name: 'data' | 'payload'): string => {
  const delimiter = name === 'data' ? INSTALLER_DATA_DELIMITER : INSTALLER_PAYLOAD_DELIMITER;
  const start = `<<'${delimiter}'\n`;
  const from = installer.indexOf(start);
  const to = installer.indexOf(`\n${delimiter}\n`, from + start.length);
  if (from < 0 || to < 0) {
    throw new Error(`installer omitted its literal ${name} block`);
  }
  return installer.slice(from + start.length, to);
};
export const embeddedBootstrap = (installer: string): unknown =>
  JSON.parse(literalBlock(installer, 'data')) as unknown;

export const embeddedPayload = (installer: string): string => literalBlock(installer, 'payload');
export const withArchives = (
  input: InstallerBuilderInput,
  mutate: (archives: readonly NodeArchiveFixture[]) => readonly NodeArchiveFixture[],
): InstallerBuilderInput => ({
  ...input,
  manifest: {
    ...input.manifest,
    toolchain: {
      ...input.manifest.toolchain,
      nodeArchives: mutate(input.manifest.toolchain.nodeArchives),
    },
  },
});
export const archiveAt = (
  archives: readonly NodeArchiveFixture[],
  index: number,
): NodeArchiveFixture => {
  const archive = archives[index];
  if (archive === undefined) {
    throw new Error(`fixture omitted Node archive ${index}`);
  }
  return archive;
};
export const expectedBootstrap = (input: InstallerBuilderInput): EmbeddedBootstrap => ({
  schemaVersion: input.bootstrapPolicy.schemaVersion,
  nodeVersion: input.manifest.toolchain.node,
  execution: {
    downloadTimeoutSeconds: input.bootstrapPolicy.downloadTimeoutSeconds,
    nodeProbeTimeoutSeconds: input.bootstrapPolicy.nodeProbeTimeoutSeconds,
    payloadTimeoutSeconds: input.bootstrapPolicy.payloadTimeoutSeconds,
    terminationGraceSeconds: input.bootstrapPolicy.terminationGraceSeconds,
  },
  snapshot: { ...input.manifest.toolchain.nodeShasums },
  archives: [...input.manifest.toolchain.nodeArchives].sort((left, right) =>
    `${left.platform}/${left.arch}`.localeCompare(`${right.platform}/${right.arch}`),
  ),
});
