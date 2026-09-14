import {
  futureReleaseManifestFixture,
  futureReleasePolicyFixture,
  type FutureReleaseManifestFixture,
  type NodeArchiveFixture,
} from './release-manifest-fixture.js';
export const INSTALLER_DATA_SLOT = '@@REVO_NODE_BOOTSTRAP_DATA@@';
export const INSTALLER_PAYLOAD_SLOT = '@@REVO_NODE_BOOTSTRAP_PAYLOAD@@';
export const installerTemplate = `#!/bin/sh
set -eu
# revo-node-bootstrap-data-begin
${INSTALLER_DATA_SLOT}
# revo-node-bootstrap-data-end
# revo-node-bootstrap-payload-begin
${INSTALLER_PAYLOAD_SLOT}
# revo-node-bootstrap-payload-end
`;
export const installerPayload = `import { assertBootstrapMatchesManifest } from './lib/node-platform.mjs';

const bootstrap = JSON.parse(Buffer.from(process.env.REVO_BOOTSTRAP_DATA, 'base64url'));
assertBootstrapMatchesManifest(JSON.parse(process.env.REVO_MANIFEST), bootstrap);
`;
export const bootstrapPolicy = {
  schemaVersion: 'revo-node-bootstrap/v1',
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
const encodedBlock = (installer: string, name: 'data' | 'payload'): string => {
  const expression = new RegExp(
    `# revo-node-bootstrap-${name}-begin\\n# ([A-Za-z0-9_-]+)\\n# revo-node-bootstrap-${name}-end`,
    'u',
  );
  const encoded = expression.exec(installer)?.[1];
  if (encoded === undefined) {
    throw new Error(`installer omitted its encoded ${name} block`);
  }
  return encoded;
};
export const embeddedBootstrap = (installer: string): unknown =>
  JSON.parse(Buffer.from(encodedBlock(installer, 'data'), 'base64url').toString('utf8')) as unknown;

export const embeddedPayload = (installer: string): string =>
  Buffer.from(encodedBlock(installer, 'payload'), 'base64url').toString('utf8');
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
  snapshot: { ...input.manifest.toolchain.nodeShasums },
  archives: [...input.manifest.toolchain.nodeArchives].sort((left, right) =>
    `${left.platform}/${left.arch}`.localeCompare(`${right.platform}/${right.arch}`),
  ),
});
