import { validateInstallationReleaseManifest } from './lib/release-metadata.mjs';

const DATA_SLOT = '@@REVO_NODE_BOOTSTRAP_DATA@@';
const PAYLOAD_SLOT = '@@REVO_NODE_BOOTSTRAP_PAYLOAD@@';
const SLOT_PATTERN = /@@[A-Z0-9_]+@@/gu;
const LAB_MARKER_PATTERN = /revo-(?:fixture|lab|test)-/iu;
const POLICY_KEYS = ['schemaVersion', 'targets'];
const TARGET_KEYS = ['arch', 'format', 'platform'];
const TARGETS = [
  ['darwin', 'arm64', 'tar.gz'],
  ['darwin', 'x64', 'tar.gz'],
  ['linux', 'arm64', 'tar.xz'],
  ['linux', 'x64', 'tar.xz'],
  ['win32', 'arm64', 'zip'],
  ['win32', 'x64', 'zip'],
];

const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const exact = (value, keys) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const targetIdentity = ({ platform, arch, format }) => `${platform}/${arch}/${format}`;

function validateInput(input) {
  if (!record(input)) {
    throw new Error('Invalid installer builder input');
  }
  if (!record(input.manifest)) {
    throw new Error('Invalid installer manifest input');
  }
  if (!validReleasePolicy(input.policy)) {
    throw new Error('Invalid installer release policy input');
  }
  if (typeof input.template !== 'string') {
    throw new Error('Invalid installer template input');
  }
  if (typeof input.payload !== 'string') {
    throw new Error('Invalid installer payload input');
  }
  return input;
}

function validReleasePolicy(policy) {
  return (
    record(policy) &&
    Array.isArray(policy.supportedSchemaVersions) &&
    policy.supportedSchemaVersions.every((version) => typeof version === 'string') &&
    record(policy.locators) &&
    record(policy.locators.artifacts) &&
    ['package', 'packageJson', 'pnpmLock', 'pnpmWorkspace'].every(
      (name) => typeof policy.locators.artifacts[name] === 'function',
    ) &&
    ['manifest', 'channel', 'nodeArchive', 'nodeShasums'].every(
      (name) => typeof policy.locators[name] === 'function',
    )
  );
}

function validateBootstrapPolicy(policy) {
  if (
    !record(policy) ||
    !exact(policy, POLICY_KEYS) ||
    policy.schemaVersion !== 'revo-node-bootstrap/v1' ||
    !Array.isArray(policy.targets) ||
    policy.targets.length !== TARGETS.length ||
    !policy.targets.every((target) => record(target) && exact(target, TARGET_KEYS))
  ) {
    throw new Error('Invalid Node bootstrap policy schema or targets');
  }
  const actual = policy.targets.map(targetIdentity);
  const expected = TARGETS.map(([platform, arch, format]) => `${platform}/${arch}/${format}`);
  if (
    new Set(actual).size !== actual.length ||
    !expected.every((target) => actual.includes(target))
  ) {
    throw new Error('Invalid Node bootstrap policy target set or format');
  }
  return { schemaVersion: policy.schemaVersion, identities: expected };
}

function validateTemplate(template, payload) {
  if (LAB_MARKER_PATTERN.test(template) || LAB_MARKER_PATTERN.test(payload)) {
    throw new Error('Invalid installer template or payload marker');
  }
  for (const slot of [DATA_SLOT, PAYLOAD_SLOT]) {
    if (template.split(slot).length !== 2) {
      throw new Error(`Invalid installer template ${slot} slot`);
    }
  }
  const slots = template.match(SLOT_PATTERN) ?? [];
  if (slots.length !== 2 || !slots.includes(DATA_SLOT) || !slots.includes(PAYLOAD_SLOT)) {
    throw new Error('Invalid installer template unresolved slot');
  }
}

const encodeComment = (value) => `# ${Buffer.from(value, 'utf8').toString('base64url')}`;

export function buildInstaller(value) {
  const input = validateInput(value);
  const bootstrapPolicy = validateBootstrapPolicy(input.bootstrapPolicy);
  validateTemplate(input.template, input.payload);
  const manifest = validateInstallationReleaseManifest(input.manifest, input.policy);
  if (manifest.schemaVersion !== 'revo-install/v2') {
    throw new Error('Invalid installer manifest schema version: expected revo-install/v2');
  }
  const archivesByTarget = new Map(
    manifest.toolchain.nodeArchives.map((archive) => [targetIdentity(archive), archive]),
  );
  const bootstrap = {
    schemaVersion: bootstrapPolicy.schemaVersion,
    nodeVersion: manifest.toolchain.node,
    snapshot: { ...manifest.toolchain.nodeShasums },
    archives: bootstrapPolicy.identities.map((identity) => ({ ...archivesByTarget.get(identity) })),
  };
  const data = encodeComment(JSON.stringify(bootstrap));
  const payload = encodeComment(input.payload);
  return input.template.replace(DATA_SLOT, data).replace(PAYLOAD_SLOT, payload);
}
