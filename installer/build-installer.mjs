import { validateInstallationReleaseManifest } from './lib/release-metadata.mjs';

const DATA_SLOT = '@@REVO_NODE_BOOTSTRAP_DATA@@';
const PAYLOAD_SLOT = '@@REVO_NODE_BOOTSTRAP_PAYLOAD@@';
const POSIX_SLOT = '@@REVO_POSIX_BOOTSTRAP_TABLE@@';
const DATA_DELIMITER = 'REVO_NODE_BOOTSTRAP_DATA';
const PAYLOAD_DELIMITER = 'REVO_NODE_BOOTSTRAP_PAYLOAD';
const SLOT_PATTERN = /@@[A-Z0-9_]+@@/gu;
const LAB_MARKER_PATTERN = /revo-(?:fixture|lab|test)-/iu;
const POLICY_KEYS = [
  'schemaVersion',
  'downloadTimeoutSeconds',
  'nodeProbeTimeoutSeconds',
  'payloadTimeoutSeconds',
  'terminationGraceSeconds',
  'targets',
];
const TARGET_KEYS = ['arch', 'format', 'platform'];
const TARGETS = [
  ['darwin', 'arm64', 'tar.gz'],
  ['darwin', 'x64', 'tar.gz'],
  ['linux', 'arm64', 'tar.xz'],
  ['linux', 'x64', 'tar.xz'],
  ['win32', 'arm64', 'zip'],
  ['win32', 'x64', 'zip'],
];
const POSIX_TARGETS = new Set(
  TARGETS.slice(0, 4).map(([platform, arch, format]) => `${platform}/${arch}/${format}`),
);
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value, keys) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const targetIdentity = ({ platform, arch, format }) => `${platform}/${arch}/${format}`;
const duration = (value) => Number.isSafeInteger(value) && value > 0;
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

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
    !duration(policy.downloadTimeoutSeconds) ||
    !duration(policy.nodeProbeTimeoutSeconds) ||
    !duration(policy.payloadTimeoutSeconds) ||
    !duration(policy.terminationGraceSeconds) ||
    !Array.isArray(policy.targets) ||
    policy.targets.length !== TARGETS.length ||
    !policy.targets.every((target) => record(target) && exact(target, TARGET_KEYS))
  ) {
    throw new Error('Invalid Node bootstrap policy schema, duration, or targets');
  }
  const actual = policy.targets.map(targetIdentity);
  const identities = TARGETS.map(([platform, arch, format]) => `${platform}/${arch}/${format}`);
  if (
    new Set(actual).size !== actual.length ||
    !identities.every((target) => actual.includes(target))
  ) {
    throw new Error('Invalid Node bootstrap policy target set or format');
  }
  return { ...policy, identities };
}

function validateTemplate(template, payload) {
  if (LAB_MARKER_PATTERN.test(template) || LAB_MARKER_PATTERN.test(payload)) {
    throw new Error('Invalid installer template or payload marker');
  }
  for (const delimiter of [DATA_DELIMITER, PAYLOAD_DELIMITER]) {
    const standalone = new RegExp(`^${delimiter}$`, 'gmu');
    if ((template.match(standalone) ?? []).length !== 1 || standalone.test(payload)) {
      throw new Error('Invalid installer heredoc delimiter collision');
    }
  }
  for (const slot of [DATA_SLOT, PAYLOAD_SLOT, POSIX_SLOT]) {
    if (template.split(slot).length !== 2) {
      throw new Error(`Invalid installer template ${slot} slot`);
    }
  }
  const slots = template.match(SLOT_PATTERN) ?? [];
  if (
    slots.length !== 3 ||
    ![DATA_SLOT, PAYLOAD_SLOT, POSIX_SLOT].every((slot) => slots.includes(slot))
  ) {
    throw new Error('Invalid installer template unresolved slot');
  }
}

function posixTable(bootstrap) {
  return bootstrap.archives
    .filter((archive) => POSIX_TARGETS.has(targetIdentity(archive)))
    .map((archive) => {
      const target = `${archive.platform}-${archive.arch}`;
      const receipt = JSON.stringify({
        version: bootstrap.nodeVersion,
        target,
        archiveSha256: archive.sha256,
      });
      return `${archive.platform}/${archive.arch}/${archive.format}) revo_platform=${shellQuote(archive.platform)}; revo_arch=${shellQuote(archive.arch)}; revo_format=${shellQuote(archive.format)}; revo_url=${shellQuote(archive.url)}; revo_sha256=${shellQuote(archive.sha256)}; revo_version=${shellQuote(bootstrap.nodeVersion)}; revo_expected_receipt=${shellQuote(receipt)}; revo_download_timeout=${shellQuote(bootstrap.execution.downloadTimeoutSeconds)}; revo_probe_timeout=${shellQuote(bootstrap.execution.nodeProbeTimeoutSeconds)}; revo_payload_timeout=${shellQuote(bootstrap.execution.payloadTimeoutSeconds)}; revo_grace=${shellQuote(bootstrap.execution.terminationGraceSeconds)} ;;`;
    })
    .join('\n');
}

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
    execution: {
      downloadTimeoutSeconds: bootstrapPolicy.downloadTimeoutSeconds,
      nodeProbeTimeoutSeconds: bootstrapPolicy.nodeProbeTimeoutSeconds,
      payloadTimeoutSeconds: bootstrapPolicy.payloadTimeoutSeconds,
      terminationGraceSeconds: bootstrapPolicy.terminationGraceSeconds,
    },
    snapshot: { ...manifest.toolchain.nodeShasums },
    archives: bootstrapPolicy.identities.map((identity) => ({ ...archivesByTarget.get(identity) })),
  };
  return input.template
    .replace(POSIX_SLOT, () => posixTable(bootstrap))
    .replace(DATA_SLOT, () => JSON.stringify(bootstrap))
    .replace(PAYLOAD_SLOT, () => input.payload);
}
