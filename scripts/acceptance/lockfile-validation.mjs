import { createHash } from 'node:crypto';

import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from 'yaml';

const POLICY = 'revo-tui-lock-override-v1';
const TUI_NAME = '@revisium/revo-tui';
const MAX_LOCK_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 200_000;
const MAX_DEPTH = 96;
const MAX_REFERENCE_LENGTH = 16 * 1024;
const MAX_PEER_DEPTH = 32;
const MAX_PEER_GROUPS = 256;
const MAX_REFERENCE_EDGES = 100_000;
const IDENTIFIER = /^[0-9A-Za-z-]+$/u;
const NUMERIC_IDENTIFIER = /^(0|[1-9]\d*)$/u;
const SRI_SHA512 = /^sha512-([A-Za-z0-9+/]{86}==)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function fail(message, code = 'LOCK_SCHEMA') {
  const error = new Error(`acceptance lock validation: ${message}`);
  error.code = code;
  throw error;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isCanonicalSha512(value) {
  const match = typeof value === 'string' ? SRI_SHA512.exec(value) : null;
  return (
    match !== null &&
    Buffer.from(match[1], 'base64').length === 64 &&
    Buffer.from(match[1], 'base64').toString('base64') === match[1]
  );
}

function hasUrlControlOrSpace(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) {
      return true;
    }
    if (character === '\\') {
      return true;
    }
  }
  return false;
}

function parseLockDocuments(bytes, label) {
  if (!(bytes instanceof Uint8Array)) {
    fail(`${label} lockfile must be provided as bytes`, 'LOCK_INPUT');
  }
  if (bytes.length === 0 || bytes.length > MAX_LOCK_BYTES) {
    fail(`${label} lockfile is empty or exceeds the size limit`, 'LOCK_LIMIT');
  }

  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} lockfile is not valid UTF-8`, 'LOCK_INPUT');
  }

  let documents;
  try {
    documents = parseAllDocuments(source, {
      prettyErrors: false,
      schema: 'core',
      strict: true,
      uniqueKeys: true,
      version: '1.2',
      intAsBigInt: true,
    });
  } catch {
    fail(`${label} lockfile could not be parsed`, 'YAML_SYNTAX');
  }
  if (documents.length !== 2) {
    fail(`${label} lockfile must contain exactly two YAML documents`, 'LOCK_DOCUMENT_PROFILE');
  }

  const state = { count: 0 };
  return documents.map((document, index) => {
    if (document.errors.length > 0 || document.warnings.length > 0) {
      fail(`${label} lockfile document ${index} has YAML diagnostics`, 'YAML_SYNTAX');
    }
    if (document.directives?.yaml?.version !== '1.2') {
      fail(`${label} lockfile document ${index} must use YAML 1.2`, 'YAML_VERSION_UNSUPPORTED');
    }
    if (!isMap(document.contents)) {
      fail(`${label} lockfile document ${index} root must be a mapping`, 'LOCK_SCHEMA');
    }
    return convertNode(document.contents, label, index, state, 0);
  });
}

function convertNode(node, label, documentIndex, state, depth) {
  state.count += 1;
  if (state.count > MAX_NODES || depth > MAX_DEPTH) {
    fail(`${label} lockfile exceeds structural limits`, 'LOCK_LIMIT');
  }
  if (isAlias(node)) {
    fail(`${label} lockfile aliases are not supported`, 'YAML_FEATURE_UNSUPPORTED');
  }
  if (node.anchor !== undefined && node.anchor !== null) {
    fail(`${label} lockfile anchors are not supported`, 'YAML_FEATURE_UNSUPPORTED');
  }
  if (node.tag !== undefined && node.tag !== null) {
    fail(`${label} lockfile explicit tags are not supported`, 'YAML_FEATURE_UNSUPPORTED');
  }

  if (isScalar(node)) {
    const value = node.value;
    if (typeof value === 'number') {
      fail(`${label} lockfile floating-point values are not supported`, 'YAML_FLOAT_UNSUPPORTED');
    }
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      typeof value !== 'bigint'
    ) {
      fail(`${label} lockfile contains an unsupported scalar`, 'YAML_FEATURE_UNSUPPORTED');
    }
    return value;
  }

  if (isSeq(node)) {
    return node.items.map((item) => convertNode(item, label, documentIndex, state, depth + 1));
  }

  if (isMap(node)) {
    const result = new Map();
    for (const pair of node.items) {
      state.count += 1;
      if (state.count > MAX_NODES) {
        fail(`${label} lockfile exceeds structural limits`, 'LOCK_LIMIT');
      }
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
        fail(`${label} lockfile mapping keys must be strings`, 'LOCK_SCHEMA');
      }
      if (pair.key.value === '<<') {
        fail(`${label} lockfile merge keys are not supported`, 'YAML_FEATURE_UNSUPPORTED');
      }
      if (pair.key.anchor !== undefined || pair.key.tag !== undefined) {
        fail(`${label} lockfile mapping key metadata is not supported`, 'YAML_FEATURE_UNSUPPORTED');
      }
      if (result.has(pair.key.value)) {
        fail(`${label} lockfile contains duplicate mapping keys`, 'YAML_SYNTAX');
      }
      result.set(pair.key.value, convertNode(pair.value, label, documentIndex, state, depth + 1));
    }
    return result;
  }

  return fail(`${label} lockfile contains an unsupported YAML node in document ${documentIndex}`);
}

function mapping(value, description) {
  if (!(value instanceof Map)) {
    fail(`${description} must be a mapping`);
  }
  return value;
}

function required(mappingValue, key, description) {
  if (!mappingValue.has(key)) {
    fail(`${description} is missing ${key}`);
  }
  return mappingValue.get(key);
}

function exactVersion(value, description) {
  if (typeof value !== 'string' || value.length > 256) {
    fail(`${description} must be an exact SemVer version`, 'REFERENCE_UNSUPPORTED');
  }
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(
      value,
    );
  if (match === null) {
    fail(`${description} must be an exact SemVer version`, 'REFERENCE_UNSUPPORTED');
  }
  const prerelease = match[4]?.split('.') ?? [];
  const build = match[5]?.split('.') ?? [];
  if (
    [...prerelease, ...build].some((part) => !IDENTIFIER.test(part)) ||
    prerelease.some((part) => /^\d+$/u.test(part) && !NUMERIC_IDENTIFIER.test(part))
  ) {
    fail(`${description} must be an exact SemVer version`, 'REFERENCE_UNSUPPORTED');
  }
  return value;
}

function validPeerPackageName(value) {
  if (value.startsWith('@')) {
    const slash = value.indexOf('/');
    return (
      slash > 1 &&
      slash < value.length - 1 &&
      /^[a-z0-9._-]+$/u.test(value.slice(1, slash)) &&
      /^[a-z0-9._-]+$/u.test(value.slice(slash + 1))
    );
  }
  return /^[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function validatePeerSuffix(suffix) {
  if (suffix === '') {
    return [];
  }
  if (suffix.length > MAX_REFERENCE_LENGTH || hasUrlControlOrSpace(suffix)) {
    fail('peer suffix exceeds the supported grammar', 'REFERENCE_UNSUPPORTED');
  }
  let cursor = 0;
  let groups = 0;
  const references = [];
  const parseGroups = (nested, depth) => {
    if (depth > MAX_PEER_DEPTH) {
      fail('peer suffix exceeds the supported nesting depth', 'LOCK_LIMIT');
    }
    while (cursor < suffix.length && suffix[cursor] === '(') {
      groups += 1;
      if (groups > MAX_PEER_GROUPS) {
        fail('peer suffix contains too many groups', 'LOCK_LIMIT');
      }
      cursor += 1;
      const nameStart = cursor;
      if (suffix[cursor] === '@') {
        const slash = suffix.indexOf('/', cursor + 1);
        if (slash < 0) {
          fail('peer suffix package name is invalid', 'REFERENCE_UNSUPPORTED');
        }
        const separator = suffix.indexOf('@', slash + 1);
        if (separator < 0) {
          fail('peer suffix package name is invalid', 'REFERENCE_UNSUPPORTED');
        }
        cursor = separator;
      } else {
        while (
          cursor < suffix.length &&
          suffix[cursor] !== '@' &&
          suffix[cursor] !== '(' &&
          suffix[cursor] !== ')'
        ) {
          cursor += 1;
        }
      }
      const packageName = suffix.slice(nameStart, cursor);
      if (!validPeerPackageName(packageName) || suffix[cursor] !== '@') {
        fail('peer suffix package locator is invalid', 'REFERENCE_UNSUPPORTED');
      }
      cursor += 1;
      const versionStart = cursor;
      while (cursor < suffix.length && suffix[cursor] !== '(' && suffix[cursor] !== ')') {
        cursor += 1;
      }
      const version = exactVersion(suffix.slice(versionStart, cursor), 'peer dependency version');
      references.push({ name: packageName, version });
      parseGroups(true, depth + 1);
      if (suffix[cursor] !== ')') {
        fail('peer suffix has unbalanced groups', 'REFERENCE_UNSUPPORTED');
      }
      cursor += 1;
    }
    if (nested && cursor < suffix.length && suffix[cursor] !== ')') {
      fail('peer suffix contains text outside a package group', 'REFERENCE_UNSUPPORTED');
    }
  };
  parseGroups(false, 0);
  if (cursor !== suffix.length) {
    fail('peer suffix contains text outside package groups', 'REFERENCE_UNSUPPORTED');
  }
  return references;
}

function peerSuffix(version, exactVersionValue) {
  if (version === exactVersionValue) {
    return '';
  }
  if (typeof version !== 'string' || !version.startsWith(exactVersionValue)) {
    fail('source importer version does not match its exact specifier', 'REFERENCE_UNSUPPORTED');
  }
  const suffix = version.slice(exactVersionValue.length);
  validatePeerSuffix(suffix);
  return suffix;
}

function packageIdentity(reference, fallbackName, { key = false } = {}) {
  if (
    typeof reference !== 'string' ||
    reference.length === 0 ||
    reference.length > MAX_REFERENCE_LENGTH
  ) {
    fail('package reference is empty or exceeds the supported length', 'REFERENCE_UNSUPPORTED');
  }
  const open = reference.indexOf('(');
  const base = open < 0 ? reference : reference.slice(0, open);
  const suffix = open < 0 ? '' : reference.slice(open);
  if (suffix !== '') {
    validatePeerSuffix(suffix);
  }
  let name = fallbackName;
  let version = base;
  if (base.startsWith('@')) {
    const slash = base.indexOf('/');
    const separator = slash < 0 ? -1 : base.indexOf('@', slash + 1);
    if (separator < 0) {
      fail('scoped package reference is malformed', 'REFERENCE_UNSUPPORTED');
    }
    name = base.slice(0, separator);
    version = base.slice(separator + 1);
  } else {
    const separator = base.indexOf('@');
    if (separator >= 0) {
      name = base.slice(0, separator);
      version = base.slice(separator + 1);
    } else if (key) {
      fail('package key has no version separator', 'REFERENCE_UNSUPPORTED');
    }
  }
  if (typeof name !== 'string' || !validPeerPackageName(name)) {
    fail('package reference name is unsupported', 'REFERENCE_UNSUPPORTED');
  }
  const exact = exactVersion(version, 'resolved package version');
  const packageKey = `${name}@${exact}`;
  return { name, version: exact, suffix, packageKey, snapshotKey: `${packageKey}${suffix}` };
}

function optionalMapping(parent, key, description) {
  const value = parent.get(key);
  if (value === undefined) {
    return new Map();
  }
  return mapping(value, description);
}

function packageAndSnapshotIndexes(packagesValue, snapshotsValue) {
  const packages = mapping(packagesValue, 'packages');
  const snapshots = mapping(snapshotsValue, 'snapshots');
  const packageByKey = new Map();
  for (const [key, value] of packages) {
    const identity = packageIdentity(key, undefined, { key: true });
    if (identity.packageKey !== key || packageByKey.has(key)) {
      fail('package record key is not canonical', 'LOCK_SCHEMA');
    }
    packageByKey.set(key, value);
  }
  const snapshotByKey = new Map();
  const snapshotsByPackageKey = new Map();
  for (const [key, value] of snapshots) {
    const identity = packageIdentity(key, undefined, { key: true });
    if (!packageByKey.has(identity.packageKey)) {
      fail('snapshot has no corresponding package record', 'REFERENCE_DANGLING');
    }
    snapshotByKey.set(key, value);
    const variants = snapshotsByPackageKey.get(identity.packageKey) ?? new Set();
    variants.add(key);
    snapshotsByPackageKey.set(identity.packageKey, variants);
  }
  return { packageByKey, snapshotByKey, snapshotsByPackageKey };
}

function resolveReference(reference, dependencyName, indexes) {
  const identity = packageIdentity(reference, dependencyName);
  if (!indexes.packageByKey.has(identity.packageKey)) {
    fail('dependency reference has no package record', 'REFERENCE_DANGLING');
  }
  if (!indexes.snapshotByKey.has(identity.snapshotKey)) {
    fail('dependency reference has no snapshot record', 'REFERENCE_DANGLING');
  }
  return identity;
}

function eachDependencySection(owner, ownerName, sectionNames, callback, edgeState) {
  for (const sectionName of sectionNames) {
    const sectionValue = owner.get(sectionName);
    if (sectionValue === undefined) {
      continue;
    }
    const section = mapping(sectionValue, `${ownerName} ${sectionName}`);
    for (const [name, value] of section) {
      edgeState.count += 1;
      if (edgeState.count > MAX_REFERENCE_EDGES) {
        fail('lockfile contains too many dependency references', 'LOCK_LIMIT');
      }
      callback(name, value, sectionName);
    }
  }
}

function assertNoSharedTuiConsumers(application, binding, expected) {
  const indexes = packageAndSnapshotIndexes(
    required(application, 'packages', 'application lockfile'),
    required(application, 'snapshots', 'application lockfile'),
  );
  const importers = mapping(
    required(application, 'importers', 'application lockfile'),
    'importers',
  );
  const edgeState = { count: 0 };
  const inspect = (reference, dependencyName, isRootTui) => {
    if (typeof reference !== 'string') {
      fail('dependency reference must be a string', 'LOCK_SCHEMA');
    }
    const resolved = resolveReference(reference, dependencyName, indexes);
    const peerReferences = resolved.suffix === '' ? [] : validatePeerSuffix(resolved.suffix);
    const pointsAtOldIdentity = resolved.packageKey === binding.packageKey;
    const peerPointsAtOldIdentity = peerReferences.some(
      ({ name, version }) => `${name}@${version}` === binding.packageKey,
    );
    const allowedRootEdge =
      isRootTui && pointsAtOldIdentity && resolved.snapshotKey === binding.snapshotKey;
    if (peerPointsAtOldIdentity || (pointsAtOldIdentity && !allowedRootEdge)) {
      fail('TUI source binding is shared by another dependency', 'TUI_BINDING_SHARED');
    }
  };

  for (const [importerName, importerValue] of importers) {
    const importer = mapping(importerValue, `importer ${importerName}`);
    eachDependencySection(
      importer,
      `importer ${importerName}`,
      ['dependencies', 'devDependencies', 'optionalDependencies'],
      (name, entry, sectionName) => {
        const record = mapping(entry, `importer ${importerName} dependency`);
        const reference = required(record, 'version', 'importer dependency');
        const isRootTui =
          importerName === '.' &&
          name === expected.name &&
          sectionName === 'dependencies' &&
          importer.get('dependencies') instanceof Map &&
          importer.get('dependencies').get(expected.name) === entry;
        inspect(reference, name, isRootTui);
      },
      edgeState,
    );
  }

  for (const [snapshotKey, snapshotValue] of indexes.snapshotByKey) {
    const snapshot = mapping(snapshotValue, `snapshot ${snapshotKey}`);
    eachDependencySection(
      snapshot,
      `snapshot ${snapshotKey}`,
      ['dependencies', 'optionalDependencies'],
      (name, reference) => inspect(reference, name, false),
      edgeState,
    );
    const identity = packageIdentity(snapshotKey, undefined, { key: true });
    const peerReferences = identity.suffix === '' ? [] : validatePeerSuffix(identity.suffix);
    if (peerReferences.some(({ name, version }) => `${name}@${version}` === binding.packageKey)) {
      fail('TUI source binding is used by another peer variant', 'TUI_BINDING_SHARED');
    }
  }

  const variants = indexes.snapshotsByPackageKey.get(binding.packageKey) ?? new Set();
  if ([...variants].some((key) => key !== binding.snapshotKey)) {
    fail('TUI source package has another peer snapshot variant', 'TUI_BINDING_SHARED');
  }
}

function assertToolchainProfile(document, sourcePackage) {
  if (required(document, 'lockfileVersion', 'toolchain document') !== '9.0') {
    fail('toolchain document lockfile version is unsupported', 'LOCK_DOCUMENT_PROFILE');
  }
  const importers = mapping(
    required(document, 'importers', 'toolchain document'),
    'toolchain importers',
  );
  if (importers.size !== 1 || !importers.has('.')) {
    fail('toolchain document must contain only the root importer', 'LOCK_DOCUMENT_PROFILE');
  }
  const importer = mapping(importers.get('.'), 'toolchain root importer');
  const manager = /^pnpm@(.+)$/u.exec(sourcePackage?.packageManager ?? '')?.[1];
  if (manager === undefined) {
    fail('source packageManager must pin pnpm', 'TOOLCHAIN_BINDING');
  }
  exactVersion(manager, 'source pnpm version');
  if (manager !== '12.5.1') {
    fail('toolchain profile supports only the validated pnpm version', 'TOOLCHAIN_BINDING');
  }
  const configDependencies = mapping(
    required(importer, 'configDependencies', 'toolchain root importer'),
    'toolchain configDependencies',
  );
  if (configDependencies.size !== 0) {
    fail('toolchain profile does not support config dependencies', 'TOOLCHAIN_BINDING');
  }
  const managerDependencies = mapping(
    required(importer, 'packageManagerDependencies', 'toolchain root importer'),
    'toolchain packageManagerDependencies',
  );
  if (managerDependencies.size !== 1 || !managerDependencies.has('pnpm')) {
    fail('toolchain root importer must pin only pnpm', 'TOOLCHAIN_BINDING');
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (optionalMapping(importer, section, `toolchain importer ${section}`).size !== 0) {
      fail('toolchain importer has unsupported dependency entries', 'TOOLCHAIN_BINDING');
    }
  }
  const rootPnpm = mapping(managerDependencies.get('pnpm'), 'toolchain pnpm dependency');
  if (rootPnpm.get('specifier') !== manager || rootPnpm.get('version') !== manager) {
    fail('toolchain pnpm version does not match source packageManager', 'TOOLCHAIN_BINDING');
  }
  const indexes = packageAndSnapshotIndexes(
    required(document, 'packages', 'toolchain document'),
    required(document, 'snapshots', 'toolchain document'),
  );
  const root = resolveReference(rootPnpm.get('version'), 'pnpm', indexes);
  const visited = new Set();
  const queue = [root];
  const edgeState = { count: 0 };
  const reachedPackageKeys = new Set();
  while (queue.length > 0) {
    const identity = queue.pop();
    if (visited.has(identity.snapshotKey)) {
      continue;
    }
    visited.add(identity.snapshotKey);
    reachedPackageKeys.add(identity.packageKey);
    if (!(identity.name === 'pnpm' || identity.name.startsWith('@pnpm/exe.'))) {
      fail('toolchain graph contains an unexpected package', 'TOOLCHAIN_BINDING');
    }
    const packageRecord = mapping(
      indexes.packageByKey.get(identity.packageKey),
      'toolchain package record',
    );
    if (
      (packageRecord.has('name') && packageRecord.get('name') !== identity.name) ||
      (packageRecord.has('version') && packageRecord.get('version') !== identity.version)
    ) {
      fail('toolchain package metadata does not match its locator', 'TOOLCHAIN_BINDING');
    }
    const resolution = mapping(
      required(packageRecord, 'resolution', 'toolchain package record'),
      'toolchain resolution',
    );
    if (
      resolution.size !== 1 ||
      !isCanonicalSha512(required(resolution, 'integrity', 'toolchain resolution'))
    ) {
      fail('toolchain packages must use integrity-only registry resolutions', 'TOOLCHAIN_BINDING');
    }
    const snapshot = mapping(indexes.snapshotByKey.get(identity.snapshotKey), 'toolchain snapshot');
    eachDependencySection(
      snapshot,
      `toolchain snapshot ${identity.snapshotKey}`,
      ['dependencies', 'optionalDependencies'],
      (name, reference) => queue.push(resolveReference(reference, name, indexes)),
      edgeState,
    );
  }
  if (visited.size !== indexes.snapshotByKey.size) {
    fail('toolchain lockfile contains unreachable package snapshots', 'TOOLCHAIN_BINDING');
  }
  if (reachedPackageKeys.size !== indexes.packageByKey.size) {
    fail('toolchain lockfile contains unreachable package records', 'TOOLCHAIN_BINDING');
  }
}

function assertExpectedArtifact(expected) {
  if (expected?.name !== TUI_NAME) {
    fail('expected package name is outside the TUI override policy', 'ARTIFACT_INPUT');
  }
  try {
    exactVersion(expected.version, 'expected tarball version');
  } catch {
    fail('expected tarball version is invalid', 'ARTIFACT_INPUT');
  }
  if (typeof expected.url !== 'string' || typeof expected.integrity !== 'string') {
    fail('expected tarball URL or integrity is missing', 'ARTIFACT_INPUT');
  }
  if (!SHA256.test(expected.tarballSha256)) {
    fail('expected tarball SHA256 is invalid', 'ARTIFACT_INPUT');
  }
  const sriMatch = SRI_SHA512.exec(expected.integrity);
  if (
    sriMatch === null ||
    Buffer.from(sriMatch[1], 'base64').length !== 64 ||
    Buffer.from(sriMatch[1], 'base64').toString('base64') !== sriMatch[1]
  ) {
    fail('expected tarball integrity is not a canonical SHA512 SRI value', 'ARTIFACT_INPUT');
  }
  if (hasUrlControlOrSpace(expected.url)) {
    fail('expected tarball URL contains whitespace or controls', 'ARTIFACT_INPUT');
  }
  let parsed;
  try {
    parsed = new URL(expected.url);
  } catch {
    fail('expected tarball URL must be absolute HTTPS', 'ARTIFACT_INPUT');
  }
  const pathMatch = /^\/tui\/([a-f0-9]{64})\/([A-Za-z0-9][A-Za-z0-9._-]*\.tgz)$/u.exec(
    parsed.pathname,
  );
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.href !== expected.url ||
    parsed.search !== `?sha256=${expected.tarballSha256}` ||
    parsed.hash !== '' ||
    pathMatch === null ||
    pathMatch[1] !== expected.tarballSha256 ||
    pathMatch[2] === '.' ||
    pathMatch[2] === '..'
  ) {
    fail('expected tarball URL does not bind the exact canonical artifact route', 'ARTIFACT_INPUT');
  }
}

function sourceTuiBinding(documents, sourcePackage, expected) {
  const version = exactVersion(
    sourcePackage?.dependencies?.[expected.name],
    'source TUI dependency',
  );
  const application = mapping(documents[1], 'application lockfile document');
  const importers = mapping(
    required(application, 'importers', 'application lockfile'),
    'importers',
  );
  const importer = mapping(required(importers, '.', 'root importer'), 'root importer');
  const dependencies = mapping(
    required(importer, 'dependencies', 'root importer'),
    'root dependencies',
  );
  const dependency = mapping(
    required(dependencies, expected.name, 'root dependencies'),
    'TUI dependency',
  );
  if (dependency.get('specifier') !== version) {
    fail('source importer specifier does not match the source package manifest');
  }
  const reference = required(dependency, 'version', 'source TUI dependency');
  const suffix = peerSuffix(reference, version);
  for (const locator of [
    `${expected.name}@${version}`,
    `${expected.name}@${version}${suffix}`,
    `${expected.url}${suffix}`,
    `${expected.name}@${expected.url}`,
    `${expected.name}@${expected.url}${suffix}`,
  ]) {
    if (locator.length > MAX_REFERENCE_LENGTH) {
      fail('TUI package or snapshot reference exceeds the supported length', 'LOCK_LIMIT');
    }
  }
  const packages = mapping(required(application, 'packages', 'application lockfile'), 'packages');
  const snapshots = mapping(
    required(application, 'snapshots', 'application lockfile'),
    'snapshots',
  );
  const packageKey = `${expected.name}@${version}`;
  const snapshotKey = `${expected.name}@${version}${suffix}`;
  const packageRecord = mapping(
    required(packages, packageKey, 'source TUI package record'),
    'source TUI package record',
  );
  const resolution = mapping(
    required(packageRecord, 'resolution', 'source TUI package record'),
    'source TUI resolution',
  );
  if (
    [...resolution.keys()].some((key) => !['integrity', 'tarball'].includes(key)) ||
    !isCanonicalSha512(required(resolution, 'integrity', 'source TUI resolution'))
  ) {
    fail('source TUI registry resolution is unsupported', 'TOOLCHAIN_BINDING');
  }
  if (resolution.has('tarball')) {
    let tarball;
    try {
      tarball = new URL(resolution.get('tarball'));
    } catch {
      fail('source TUI registry tarball URL is invalid', 'TOOLCHAIN_BINDING');
    }
    if (tarball.protocol !== 'https:' || tarball.username !== '' || tarball.password !== '') {
      fail('source TUI registry tarball URL is unsupported', 'TOOLCHAIN_BINDING');
    }
  }
  if (packageRecord.has('version') && packageRecord.get('version') !== version) {
    fail('source TUI package record version is inconsistent');
  }
  const snapshot = mapping(
    required(snapshots, snapshotKey, 'source TUI snapshot'),
    'source TUI snapshot',
  );
  assertNoSharedTuiConsumers(application, { packageKey, snapshotKey }, expected);
  return {
    application,
    importer,
    dependency,
    packages,
    snapshots,
    packageKey,
    snapshotKey,
    suffix,
    packageRecord,
    snapshot,
  };
}

function cloneValue(value) {
  if (value instanceof Map) {
    return new Map([...value].map(([key, item]) => [key, cloneValue(item)]));
  }
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  return value;
}

function structurallyEqual(left, right) {
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) {
      return false;
    }
    for (const [key, value] of left) {
      if (!right.has(key) || !structurallyEqual(value, right.get(key))) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      structurallyEqual(leftKeys, rightKeys) &&
      leftKeys.every((key) => structurallyEqual(left[key], right[key]))
    );
  }
  return Object.is(left, right);
}

function clonePackage(value) {
  if (Array.isArray(value)) {
    return value.map(clonePackage);
  }
  if (value !== null && typeof value === 'object') {
    const result = Object.create(null);
    for (const key of Object.keys(value)) {
      Object.defineProperty(result, key, {
        value: clonePackage(value[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  return value;
}

function assertPackageOverride(sourcePackage, stagedPackage, expected) {
  if (
    sourcePackage === null ||
    typeof sourcePackage !== 'object' ||
    stagedPackage === null ||
    typeof stagedPackage !== 'object' ||
    sourcePackage.name !== stagedPackage.name ||
    sourcePackage.dependencies?.[expected.name] === undefined ||
    stagedPackage.dependencies?.[expected.name] !== expected.url
  ) {
    fail('staging package manifest has no exact TUI dependency override', 'PACKAGE_DRIFT');
  }
  const expectedPackage = clonePackage(sourcePackage);
  Object.defineProperty(expectedPackage.dependencies, expected.name, {
    value: expected.url,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  if (!structurallyEqual(expectedPackage, stagedPackage)) {
    fail('staging package manifest changed outside the TUI dependency override', 'PACKAGE_DRIFT');
  }
}

function expectedAfter(beforeDocuments, binding, expected) {
  const documents = beforeDocuments.map(cloneValue);
  const application = documents[1];
  const importers = application.get('importers');
  const importer = importers.get('.');
  const dependencies = importer.get('dependencies');
  const dependency = dependencies.get(expected.name);
  dependency.set('specifier', expected.url);
  dependency.set('version', `${expected.url}${binding.suffix}`);

  const targetPackageKey = `${expected.name}@${expected.url}`;
  const targetSnapshotKey = `${expected.name}@${expected.url}${binding.suffix}`;
  const packages = application.get('packages');
  const snapshots = application.get('snapshots');
  if (packages.has(targetPackageKey) || snapshots.has(targetSnapshotKey)) {
    fail('target TUI lockfile keys already exist', 'TUI_TARGET_COLLISION');
  }

  const packageRecord = packages.get(binding.packageKey);
  const resolution = new Map([
    ['integrity', expected.integrity],
    ['tarball', expected.url],
  ]);
  packageRecord.set('resolution', resolution);
  packageRecord.set('version', expected.version);
  packages.delete(binding.packageKey);
  packages.set(targetPackageKey, packageRecord);

  const snapshot = snapshots.get(binding.snapshotKey);
  snapshots.delete(binding.snapshotKey);
  snapshots.set(targetSnapshotKey, snapshot);
  return { documents, targetPackageKey, targetSnapshotKey };
}

export function validateTuiLockOverride({
  beforeLock,
  afterLock,
  sourcePackage,
  stagedPackage,
  expected,
}) {
  assertExpectedArtifact(expected);
  assertPackageOverride(sourcePackage, stagedPackage, expected);

  const beforeDocuments = parseLockDocuments(beforeLock, 'source');
  const afterDocuments = parseLockDocuments(afterLock, 'staging');
  for (const [index, document] of beforeDocuments.entries()) {
    const version = required(document, 'lockfileVersion', `source document ${index}`);
    if (version !== '9.0') {
      return fail(`source document ${index} has an unsupported lockfile version`);
    }
  }
  for (const [index, document] of afterDocuments.entries()) {
    const version = required(document, 'lockfileVersion', `staging document ${index}`);
    if (version !== '9.0') {
      return fail(`staging document ${index} has an unsupported lockfile version`);
    }
  }

  assertToolchainProfile(beforeDocuments[0], sourcePackage);
  assertToolchainProfile(afterDocuments[0], sourcePackage);
  if (!structurallyEqual(beforeDocuments[0], afterDocuments[0])) {
    fail('staging toolchain document changed', 'LOCK_DRIFT');
  }

  const binding = sourceTuiBinding(beforeDocuments, sourcePackage, expected);
  const {
    documents: expectedDocuments,
    targetPackageKey,
    targetSnapshotKey,
  } = expectedAfter(beforeDocuments, binding, expected);
  if (!structurallyEqual(expectedDocuments, afterDocuments)) {
    fail('staging lockfile has unexpected structural drift', 'LOCK_DRIFT');
  }

  return {
    policy: POLICY,
    documentCount: beforeDocuments.length,
    applicationDocumentIndex: 1,
    importer: '.',
    dependency: expected.name,
    sourceLockSha256: sha256(beforeLock),
    stagingLockSha256: sha256(afterLock),
    sourcePackageKey: binding.packageKey,
    targetPackageKey,
    sourceSnapshotKey: binding.snapshotKey,
    targetSnapshotKey,
    peerSuffix: binding.suffix,
    url: expected.url,
    integrity: expected.integrity,
    tarballSha256: expected.tarballSha256,
    version: expected.version,
  };
}

export function validateTuiLockSource({ sourceLock, sourcePackage, expected }) {
  assertExpectedArtifact(expected);
  const documents = parseLockDocuments(sourceLock, 'source');
  for (const [index, document] of documents.entries()) {
    if (required(document, 'lockfileVersion', `source document ${index}`) !== '9.0') {
      fail(`source document ${index} has an unsupported lockfile version`, 'LOCK_DOCUMENT_PROFILE');
    }
  }
  assertToolchainProfile(documents[0], sourcePackage);
  const binding = sourceTuiBinding(documents, sourcePackage, expected);
  return {
    policy: POLICY,
    sourceLockSha256: sha256(sourceLock),
    sourcePackageKey: binding.packageKey,
    sourceSnapshotKey: binding.snapshotKey,
    peerSuffix: binding.suffix,
  };
}
