import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { Dir } from 'node:fs';
import {
  type FileHandle,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { runInNewContext } from 'node:vm';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { readActivation, type ActivationReadResult } from '../src/installation/activation-store.js';
import { ServerOwnershipService } from '../src/processes/server-ownership.service.js';
import { parseLifecycleDocument } from '../src/server-logs/document.js';
import { ServerLifecycleStore, serverLifecyclePath } from '../src/server-logs/store.service.js';
import { activationScenario } from './support/installation/activation-scenario.js';
import {
  sanitizeInitialDiagnostic,
  serializeInitialInstallFailureReceipt,
  type InitialInstallFailureTestCase,
  type InitialInstallDiagnostics,
} from './support/installation/initial-install-diagnostic-sanitizer.js';
import {
  captureIntelSnapshot as captureIntelSnapshotUnsafe,
  cleanupPortableToolchain,
  collectInstallAttemptDiagnostics,
  collectInitialInstallFailureRecords,
  collectInitialInstallFailureDiagnostics,
  fetchPinnedPnpmFixtureArchive,
  type InitialDiagnosticCollectionLease,
  type InitialDiagnosticCloseOperations,
  intelCollectorsQuiescent,
  installerData,
  nodeData,
  nodeInstaller,
  portableToolchain,
  prepareIntelInvocation,
  recordIntelCollectorIssue,
  resolveToolchainFixtureHome,
  runWithPortableToolchainCleanup,
  startInitialDiagnosticCollection,
  toolchainInstaller,
  writeIntelDiagnosticSummary,
} from './support/installation/installer-toolchain-scenario.js';
import { ServerOwnerScenario } from './support/server/server-owner-scenario.js';

type PnpmArchiveDescriptor = {
  readonly platform: string;
  readonly arch: string;
  readonly sha256: string;
  readonly url: string;
};
type PnpmBootstrap = {
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
  readonly channel: 'stable' | 'alpha';
  readonly pnpmArchives: readonly PnpmArchiveDescriptor[];
  readonly [key: string]: unknown;
};
type PnpmProbeProvision = {
  readonly bootstrap: PnpmBootstrap;
  readonly nodeExecutable: string;
  readonly privateNodeRoot: string;
  readonly channelRoot: string;
  readonly scratch: string;
  readonly platform: 'darwin' | 'linux';
  readonly arch: 'arm64' | 'x64';
  readonly request: (url: string) => Promise<{
    readonly status: number;
    readonly headers: Headers;
    readonly body: AsyncIterable<Uint8Array>;
  }>;
};
type PnpmProbeApi = {
  provisionPnpm: (input: PnpmProbeProvision) => Promise<{
    readonly executablePath: string;
    readonly reused: boolean;
    readonly version: string;
  }>;
};

const pnpmProbeApi = await vi.importActual<PnpmProbeApi>(
  new URL('../installer/node-bootstrap.mjs', import.meta.url).href,
);

const isPnpmBootstrap = (value: unknown): value is PnpmBootstrap =>
  typeof value === 'object' &&
  value !== null &&
  'nodeVersion' in value &&
  typeof value.nodeVersion === 'string' &&
  'pnpmVersion' in value &&
  typeof value.pnpmVersion === 'string' &&
  'channel' in value &&
  (value.channel === 'stable' || value.channel === 'alpha') &&
  'pnpmArchives' in value &&
  Array.isArray(value.pnpmArchives) &&
  value.pnpmArchives.every(
    (archive: unknown) =>
      typeof archive === 'object' &&
      archive !== null &&
      'platform' in archive &&
      typeof archive.platform === 'string' &&
      'arch' in archive &&
      typeof archive.arch === 'string' &&
      'sha256' in archive &&
      typeof archive.sha256 === 'string' &&
      'url' in archive &&
      typeof archive.url === 'string',
  );

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const privateNodeProbeWrapper = (evidencePath: string, exitCode?: number) => `#!/bin/sh
set -eu
umask 077
printf '%s\\0' "$0" "$PWD" "$HOME" "$TMPDIR" "$PATH" "\${REVO_PRIVATE_NODE_ROOT+x}" "$#" "$1" "$2" "$3" >> ${shellQuote(evidencePath)}
${exitCode === undefined ? '' : `exit ${exitCode}`}
exec ${shellQuote(process.execPath)} "$@"
`;

const privateNodeProbeFixture = async (exitCode?: number) => {
  const subject = await portableToolchain('stable');
  const requestedRoot = await mkdtemp(join(tmpdir(), 'revo-pnpm-private-node-probe-'));
  const root = await realpath(requestedRoot);
  const privateNodeRoot = join(root, 'private-node');
  const privateNodeBin = join(privateNodeRoot, 'bin');
  const nodeExecutable = join(privateNodeBin, 'node');
  const evidenceDirectory = join(root, 'evidence');
  const evidencePath = join(evidenceDirectory, 'invocations.bin');
  const scratch = join(root, 'scratch');
  const channelRoot = join(root, 'channel');
  await Promise.all([
    mkdir(privateNodeBin, { recursive: true, mode: 0o700 }),
    mkdir(evidenceDirectory, { mode: 0o700 }),
    mkdir(scratch, { mode: 0o700 }),
    mkdir(channelRoot, { mode: 0o700 }),
  ]);
  await writeFile(nodeExecutable, privateNodeProbeWrapper(evidencePath, exitCode), { mode: 0o700 });
  await chmod(nodeExecutable, 0o700);

  const rawBootstrap = await installerData('stable');
  if (!isPnpmBootstrap(rawBootstrap)) {
    throw new Error('invalid pnpm bootstrap fixture');
  }
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const descriptor = rawBootstrap.pnpmArchives.find(
    (item) => item.platform === platform && item.arch === arch,
  );
  if (descriptor === undefined) {
    throw new Error('pnpm bootstrap omitted current target');
  }
  const bootstrap: PnpmBootstrap = {
    ...rawBootstrap,
    pnpmArchives: rawBootstrap.pnpmArchives.map((item) =>
      item === descriptor ? { ...item, sha256: subject.pnpmArchiveSha256 } : item,
    ),
  };
  const bytes = await readFile(subject.pnpmArchive);
  const request = vi.fn<PnpmProbeProvision['request']>(async (url) => {
    if (url !== descriptor.url) {
      throw new Error('unexpected pnpm archive request');
    }
    return {
      status: 200,
      headers: new Headers({ 'content-length': String(bytes.length) }),
      body: (async function* () {
        yield bytes;
      })(),
    };
  });
  const provision = () =>
    pnpmProbeApi.provisionPnpm({
      bootstrap,
      nodeExecutable,
      privateNodeRoot,
      channelRoot,
      scratch,
      platform,
      arch,
      request,
    });
  const target = join(
    channelRoot,
    'pnpm',
    bootstrap.nodeVersion,
    `${platform}-${arch}`,
    bootstrap.pnpmVersion,
  );
  const invocations = async () => {
    const encoded = await readFile(evidencePath, 'utf8');
    const fields = encoded.split('\0');
    if (fields.at(-1) !== '') {
      throw new Error('private Node evidence is truncated');
    }
    fields.pop();
    if (fields.length % 10 !== 0) {
      throw new Error('private Node evidence is malformed');
    }
    return Array.from({ length: fields.length / 10 }, (_, index) =>
      fields.slice(index * 10, index * 10 + 10),
    );
  };
  const cleanup = async () => {
    await cleanupPortableToolchain(subject.root);
    await rm(root, { recursive: true, force: true });
  };
  return {
    bootstrap,
    channelRoot,
    cleanup,
    evidencePath,
    invocations,
    nodeExecutable,
    privateNodeBin,
    provision,
    request,
    scratch,
    subject,
    target,
  };
};

const extractWorkflowBlock = (source: string, startMarker: string, endMarker: string): string => {
  expect(source.split(startMarker)).toHaveLength(2);
  expect(source.split(endMarker)).toHaveLength(2);
  const start = source.indexOf(startMarker) + startMarker.length;
  const end = source.indexOf(endMarker);
  expect(start).toBeLessThan(end);
  return source.slice(start, end).trim();
};

let intelDiagnosticsBlock = '';
let intelOmissionsValidatorBlock = '';

it('resolves an aliased portable fixture HOME to its canonical directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revo-toolchain-home-'));
  const physicalHome = join(root, 'home');
  const requestedHome = join(root, 'home-alias');
  await mkdir(physicalHome, { mode: 0o700 });
  await symlink(physicalHome, requestedHome);
  try {
    expect(await resolveToolchainFixtureHome(requestedHome)).toBe(await realpath(physicalHome));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== 'darwin')(
  'writes lifecycle evidence through the canonical macOS fixture HOME',
  async () => {
    expect((await lstat('/tmp')).isSymbolicLink()).toBe(true);
    expect(await realpath('/tmp')).toBe('/private/tmp');

    const aliasRoot = await mkdtemp('/tmp/revo-lifecycle-home-');
    try {
      const canonicalRoot = await realpath(aliasRoot);
      const canonicalDataDir = join(canonicalRoot, 'data');
      await mkdir(canonicalDataDir, { mode: 0o700 });
      const aliasConfiguration = {
        logDir: join(aliasRoot, 'alias-logs'),
        canonicalDataDir,
        channel: 'stable' as const,
      };
      await expect(ServerLifecycleStore.open(aliasConfiguration)).rejects.toMatchObject({
        code: 'SERVER_LIFECYCLE_ERROR',
        reason: 'unsafe',
      });

      const requestedHome = join(aliasRoot, 'home');
      await mkdir(requestedHome, { mode: 0o700 });
      const home = await resolveToolchainFixtureHome(requestedHome);
      expect(home).toBe(join(canonicalRoot, 'home'));
      const configuration = {
        logDir: join(home, 'Library', 'Application Support', 'Revo', 'state', 'logs'),
        canonicalDataDir,
        channel: 'stable' as const,
      };
      const store = await ServerLifecycleStore.open(configuration);
      try {
        await store.emit('SERVER_STARTING');
      } finally {
        await store.close();
      }

      const document = parseLifecycleDocument(
        await readFile(serverLifecyclePath(configuration), 'utf8'),
      );
      expect(document?.events).toEqual([
        expect.objectContaining({ code: 'SERVER_STARTING', phase: 'server', state: 'starting' }),
      ]);
    } finally {
      await rm(aliasRoot, { recursive: true, force: true });
    }
  },
);

interface OmissionDiagnostic {
  readonly artifact: string;
  readonly invocation: string;
  readonly reason: string;
}

function isOmissionDiagnostic(value: unknown): value is OmissionDiagnostic {
  return (
    typeof value === 'object' &&
    value !== null &&
    'artifact' in value &&
    typeof value.artifact === 'string' &&
    'invocation' in value &&
    typeof value.invocation === 'string' &&
    'reason' in value &&
    typeof value.reason === 'string'
  );
}

type OmissionValidationResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly message: string };

function isOmissionValidationResult(value: unknown): value is OmissionValidationResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    (value.status === 'accepted' ||
      (value.status === 'rejected' && 'message' in value && typeof value.message === 'string'))
  );
}

beforeAll(async () => {
  const workflow = await readFile(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  intelDiagnosticsBlock = extractWorkflowBlock(
    workflow,
    '// BEGIN INTEL_EVIDENCE_DIAGNOSTICS',
    '// END INTEL_EVIDENCE_DIAGNOSTICS',
  );
  intelOmissionsValidatorBlock = extractWorkflowBlock(
    workflow,
    '// BEGIN INTEL_EVIDENCE_OMISSIONS_VALIDATOR',
    '// END INTEL_EVIDENCE_OMISSIONS_VALIDATOR',
  );
});

const validStatusOmission = (overrides: Record<string, unknown> = {}) => ({
  invocationId: 'after-initial',
  contextId: 'context-0',
  artifact: 'server-status',
  reason: 'active-status-not-queried-in-isolated-collector',
  required: true,
  ...overrides,
});

const validStatusSnapshot = (label = 'after-initial') => ({
  label,
  capturedAt: '2026-09-19T00:00:00.000Z',
  fixtures: [
    {
      contextId: 'context-0',
      channel: 'stable',
      serverStatus: {
        kind: 'unavailable',
        reason: 'active-status-not-queried-in-isolated-collector',
      },
    },
  ],
});

const runOmissionClassifier = (item: unknown) => {
  const result = runInNewContext(
    `${intelDiagnosticsBlock}\nJSON.stringify(classifyOmissionFailure(item))`,
    { item },
    { timeout: 1000 },
  );
  const parsed: unknown = JSON.parse(String(result));
  if (!isOmissionDiagnostic(parsed)) {
    throw new Error('invalid omission classifier result');
  }
  return parsed;
};

const runOmissionValidator = (input: {
  readonly omissions: unknown;
  readonly snapshots?: readonly ReturnType<typeof validStatusSnapshot>[];
  readonly collectorComplete: boolean;
}) => {
  const documents = new Map<string, unknown>();
  documents.set('omissions.json', { omissions: input.omissions });
  for (const snapshot of input.snapshots ?? []) {
    documents.set(`snapshots/${snapshot.label}.json`, snapshot);
  }
  const source = `${intelDiagnosticsBlock}
try {
${intelOmissionsValidatorBlock}
  JSON.stringify({ status: 'accepted' });
} catch (error) {
  JSON.stringify({
    status: 'rejected',
    message: formatEvidenceValidationFailure(error, validationPhase),
  });
}`;
  const result = runInNewContext(
    source,
    {
      documents,
      files: new Set<string>(),
      summary: { collectorComplete: input.collectorComplete },
    },
    { timeout: 1000 },
  );
  const parsed: unknown = JSON.parse(String(result));
  if (!isOmissionValidationResult(parsed)) {
    throw new Error('invalid omission validator result');
  }
  return parsed;
};

const omissionReasonCases = [
  ['configuration', 'unapproved-path', 'CONFIGURATION', 'UNAPPROVED_PATH'],
  ['configuration', 'invalid', 'CONFIGURATION', 'INVALID'],
  ['server-lifecycle', 'unapproved-path', 'LIFECYCLE', 'UNAPPROVED_PATH'],
  ['server-lifecycle', 'invalid', 'LIFECYCLE', 'INVALID'],
  ['server-lifecycle', 'missing-data-dir', 'LIFECYCLE', 'MISSING_DATA_DIR'],
  ['server-lifecycle', 'missing-unexpected', 'LIFECYCLE', 'MISSING_UNEXPECTED'],
  ['server-lifecycle', 'unsafe', 'LIFECYCLE', 'UNSAFE'],
  ['server-lifecycle', 'io-error', 'LIFECYCLE', 'IO_ERROR'],
  ['server-lifecycle', 'too-large', 'LIFECYCLE', 'TOO_LARGE'],
  [
    'server-lifecycle',
    'shared-lifecycle-location-required-by-another-context',
    'LIFECYCLE',
    'SHARED_LIFECYCLE_REQUIRED',
  ],
  ['attempt-inventory', 'missing-unexpected', 'INVENTORY', 'MISSING_UNEXPECTED'],
  ['attempt-inventory', 'unapproved-path', 'INVENTORY', 'UNAPPROVED_PATH'],
  ['attempt-inventory', 'unsafe', 'INVENTORY', 'UNSAFE'],
  ['attempt-inventory', 'io-error', 'INVENTORY', 'IO_ERROR'],
  ['attempt-inventory', 'captured', 'INVENTORY', 'CAPTURED'],
  ['control-record', 'unavailable', 'CONTROL', 'UNAVAILABLE'],
  ['control-record', 'unapproved-path', 'CONTROL', 'UNAPPROVED_PATH'],
  ['control-record', 'unsafe', 'CONTROL', 'UNSAFE'],
  ['control-record', 'io-error', 'CONTROL', 'IO_ERROR'],
  ['control-record', 'too-large', 'CONTROL', 'TOO_LARGE'],
  ['control-record', 'invalid', 'CONTROL', 'INVALID'],
  ['attempt-association', 'ambiguous', 'ASSOCIATION', 'AMBIGUOUS'],
  ['attempt-association', 'unresolved', 'ASSOCIATION', 'UNRESOLVED'],
  ['attempt-association', 'incomplete', 'ASSOCIATION', 'INCOMPLETE'],
  ['installer-pipes', 'pipes-incomplete', 'PIPES', 'PIPES_INCOMPLETE'],
  ['expected-node-runtime', 'unapproved-path', 'NODE', 'UNAPPROVED_PATH'],
  ['expected-node-runtime', 'unsafe', 'NODE', 'UNSAFE'],
  ['expected-node-runtime', 'missing', 'NODE', 'MISSING'],
  ['expected-node-runtime', 'io-error', 'NODE', 'IO_ERROR'],
] as const;

describe('Intel omission diagnostic contract', () => {
  it.each(omissionReasonCases)(
    'classifies the fixed reason for %s / %s',
    (artifact, reason, expectedArtifact, expectedReason) => {
      expect(runOmissionClassifier({ artifact, reason, invocationId: 'after-initial' })).toEqual({
        artifact: expectedArtifact,
        invocation: 'AFTER_INITIAL',
        reason: expectedReason,
      });
    },
  );

  it.each([
    ['initial', 'INITIAL'],
    ['cancel-before-commit', 'CANCEL_BEFORE_COMMIT'],
    ['retry-after-cancel', 'RETRY_AFTER_CANCEL'],
    ['after-initial', 'AFTER_INITIAL'],
    ['after-cancellation', 'AFTER_CANCELLATION'],
    ['after-retry', 'AFTER_RETRY'],
    ['before-cleanup', 'BEFORE_CLEANUP'],
  ] as const)('classifies the fixed invocation %s', (invocationId, expectedInvocation) => {
    expect(
      runOmissionClassifier({
        artifact: 'configuration',
        invocationId,
        reason: 'invalid',
      }).invocation,
    ).toBe(expectedInvocation);
  });

  it.each([
    {
      item: null,
      expected: { artifact: 'OTHER', invocation: 'OTHER', reason: 'OTHER' },
    },
    {
      item: 7,
      expected: { artifact: 'OTHER', invocation: 'OTHER', reason: 'OTHER' },
    },
    {
      item: {
        artifact: '/private/SECRET_PATH\nSECRET_RAW',
        invocationId: 'SECRET_RAW',
        reason: 'SECRET_RAW',
      },
      expected: { artifact: 'OTHER', invocation: 'OTHER', reason: 'OTHER' },
    },
    {
      item: {
        artifact: 'configuration',
        invocationId: 'after-initial',
        reason: 'pipes-incomplete',
      },
      expected: { artifact: 'CONFIGURATION', invocation: 'AFTER_INITIAL', reason: 'OTHER' },
    },
  ])('does not broaden fixed classifications for unknown inputs %#', ({ item, expected }) => {
    expect(runOmissionClassifier(item)).toEqual(expected);
  });

  it('keeps untrusted diagnostic values out of formatted output', () => {
    const untrustedValue = '/private/SECRET_PATH\nSECRET_RAW';
    const formatted = runInNewContext(
      `${intelDiagnosticsBlock}
const diagnostic = classifyOmissionFailure({
  artifact: untrustedValue,
  invocationId: untrustedValue,
  reason: untrustedValue,
});
formatEvidenceValidationFailure(
  new EvidenceValidationError('EVIDENCE_OMISSION_ARTIFACT_INVALID', untrustedValue, diagnostic),
  untrustedValue,
)`,
      { untrustedValue },
      { timeout: 1000 },
    );
    expect(formatted).toBe(
      'Intel evidence validation failed: EVIDENCE_OMISSION_ARTIFACT_INVALID; phase=root; artifact=OTHER; invocation=OTHER; reason=OTHER',
    );
    expect(String(formatted)).not.toContain('SECRET');
    expect(String(formatted)).not.toContain('/private');
    expect(String(formatted).length).toBeLessThanOrEqual(256);
  });

  it('formats ordinary failures without printing arbitrary error messages', () => {
    const formatted = runInNewContext(
      `${intelDiagnosticsBlock}
formatEvidenceValidationFailure(new Error('SECRET_RAW'), 'omissions')`,
      {},
      { timeout: 1000 },
    );
    expect(formatted).toBe(
      'Intel evidence validation failed: EVIDENCE_UNEXPECTED_ERROR; phase=omissions',
    );
    expect(String(formatted)).not.toContain('SECRET_RAW');
    expect(String(formatted).length).toBeLessThanOrEqual(256);
  });

  it.each([
    {
      id: 'V01 empty_without_snapshots',
      omissions: [],
      snapshots: [],
      collectorComplete: true,
      expected: { status: 'accepted' },
    },
    {
      id: 'V02 matching_status_omission',
      omissions: [validStatusOmission()],
      snapshots: [validStatusSnapshot()],
      collectorComplete: false,
      expected: { status: 'accepted' },
    },
    {
      id: 'V03 omissions_not_array',
      omissions: {},
      snapshots: [],
      collectorComplete: true,
      expected: {
        status: 'rejected',
        message:
          'Intel evidence validation failed: EVIDENCE_OMISSION_LIST_INVALID; phase=omissions',
      },
    },
    {
      id: 'V04 omissions_over_limit',
      omissions: Array.from({ length: 101 }, () => validStatusOmission()),
      snapshots: [],
      collectorComplete: true,
      expected: {
        status: 'rejected',
        message:
          'Intel evidence validation failed: EVIDENCE_OMISSION_LIST_INVALID; phase=omissions',
      },
    },
    {
      id: 'V05 omission_extra_key',
      omissions: [validStatusOmission({ unexpected: 'SECRET_RAW' })],
      snapshots: [validStatusSnapshot()],
      collectorComplete: false,
      expected: {
        status: 'rejected',
        message: 'Intel evidence validation failed: EVIDENCE_SCHEMA_INVALID; phase=omissions',
      },
    },
    {
      id: 'V06 omission_not_required',
      omissions: [validStatusOmission({ required: false })],
      snapshots: [validStatusSnapshot()],
      collectorComplete: false,
      expected: {
        status: 'rejected',
        message:
          'Intel evidence validation failed: EVIDENCE_OMISSION_CONTEXT_MISMATCH; phase=omissions',
      },
    },
    {
      id: 'V07 forbidden_artifact',
      omissions: [validStatusOmission({ artifact: 'configuration', reason: 'invalid' })],
      snapshots: [validStatusSnapshot()],
      collectorComplete: false,
      expected: {
        status: 'rejected',
        message:
          'Intel evidence validation failed: EVIDENCE_OMISSION_ARTIFACT_INVALID; phase=omissions; artifact=CONFIGURATION; invocation=AFTER_INITIAL; reason=INVALID',
      },
    },
    {
      id: 'V08 forbidden_status_reason',
      omissions: [validStatusOmission({ reason: 'SECRET_RAW' })],
      snapshots: [validStatusSnapshot()],
      collectorComplete: false,
      expected: {
        status: 'rejected',
        message:
          'Intel evidence validation failed: EVIDENCE_OMISSION_REASON_INVALID; phase=omissions',
      },
    },
    {
      id: 'V09 referenced_snapshot_missing',
      omissions: [validStatusOmission({ invocationId: 'after-retry' })],
      snapshots: [validStatusSnapshot()],
      collectorComplete: false,
      expected: {
        status: 'rejected',
        message:
          'Intel evidence validation failed: EVIDENCE_OMISSION_SNAPSHOT_MISMATCH; phase=omissions',
      },
    },
    {
      id: 'V10 referenced_context_missing',
      omissions: [validStatusOmission({ contextId: 'context-1' })],
      snapshots: [validStatusSnapshot()],
      collectorComplete: false,
      expected: {
        status: 'rejected',
        message:
          'Intel evidence validation failed: EVIDENCE_OMISSION_CONTEXT_MISMATCH; phase=omissions',
      },
    },
    {
      id: 'V11 duplicate_omission',
      omissions: [validStatusOmission(), validStatusOmission()],
      snapshots: [validStatusSnapshot()],
      collectorComplete: false,
      expected: {
        status: 'rejected',
        message: 'Intel evidence validation failed: EVIDENCE_OMISSION_DUPLICATE; phase=omissions',
      },
    },
    {
      id: 'V12 completeness_mismatch',
      omissions: [validStatusOmission()],
      snapshots: [validStatusSnapshot()],
      collectorComplete: true,
      expected: {
        status: 'rejected',
        message: 'Intel evidence validation failed: EVIDENCE_SUMMARY_INVALID; phase=omissions',
      },
    },
    {
      id: 'V13 observed_context_unaccounted',
      omissions: [],
      snapshots: [validStatusSnapshot()],
      collectorComplete: true,
      expected: {
        status: 'rejected',
        message: 'Intel evidence validation failed: EVIDENCE_SUMMARY_INVALID; phase=omissions',
      },
    },
  ])(
    '$id exercises the workflow omission validator',
    ({ omissions, snapshots, collectorComplete, expected }) => {
      expect(runOmissionValidator({ omissions, snapshots, collectorComplete })).toEqual(expected);
    },
  );
});

const syntax = (script: string) =>
  new Promise<number>((resolve) => {
    const child = spawn('/bin/sh', ['-n'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(script);
    child.once('close', (code) => resolve(code ?? 1));
  });

const validActivation = (value: ActivationReadResult) => {
  expect(value.status).toBe('valid');
  if (value.status !== 'valid') {
    throw new Error('activation was not valid');
  }
  return value;
};

describe('portable installer fixture cleanup', () => {
  it('preserves both scenario and cleanup failures', async () => {
    const scenarioFailure = new Error('scenario failed');
    const cleanupFailure = new Error('cleanup failed');
    const outcome = runWithPortableToolchainCleanup(
      '/private/fixture',
      async () => {
        throw scenarioFailure;
      },
      async () => {
        throw cleanupFailure;
      },
    );

    await expect(outcome).rejects.toMatchObject({
      errors: [scenarioFailure, cleanupFailure],
      message: expect.stringContaining('scenario failed'),
    });
  });

  it('keeps a cleanup-only failure red', async () => {
    const cleanupFailure = new Error('cleanup failed');
    await expect(
      runWithPortableToolchainCleanup(
        '/private/fixture',
        async () => 'done',
        async () => {
          throw cleanupFailure;
        },
      ),
    ).rejects.toBe(cleanupFailure);
  });

  it('preserves a scenario failure when cleanup succeeds', async () => {
    const scenarioFailure = new Error('scenario failed');
    await expect(
      runWithPortableToolchainCleanup(
        '/private/fixture',
        async () => {
          throw scenarioFailure;
        },
        async () => undefined,
      ),
    ).rejects.toBe(scenarioFailure);
  });
});

const captureIntelSnapshot = async (...args: Parameters<typeof captureIntelSnapshotUnsafe>) => {
  try {
    await captureIntelSnapshotUnsafe(...args);
    return true;
  } catch (error) {
    recordIntelCollectorIssue(
      error,
      args[1].map((fixture) => fixture.root),
    );
    console.error('Intel diagnostic snapshot incomplete.');
    return false;
  }
};

it
  .skipIf(process.env.REVO_RUN_REAL_INSTALLER_INTEGRATION !== '1')
  .each(['stable', 'alpha'] as const)(
  'real %s activation mode packs the compiled helper',
  async (channel) => {
    const subject = await portableToolchain(
      channel,
      channel === 'alpha' ? '0.0.1-alpha.1' : undefined,
      false,
      true,
    );
    let phase = 'initial-install';
    let installerOutcome = 'not-started';
    let installerStderrTail = '';
    let installerSignal: NodeJS.Signals | null = null;
    let initialFailureDiagnostics: InitialInstallDiagnostics | undefined;
    const installationStartedAt = performance.now();
    const emitFailureSnapshot = async (
      checkpoint: 'installer-failed' | 'cleanup-failed',
      installerCode: number | undefined,
      diagnostics: InitialInstallDiagnostics | undefined,
      cleanupError?: unknown,
      diagnosticsReused = false,
    ) => {
      try {
        const context = subject.diagnosticContext;
        const startupTimeoutInput = context.configurationEnvironment.REVO_STARTUP_TIMEOUT;
        const startupTimeoutMs =
          startupTimeoutInput !== undefined && /^\d{1,6}$/u.test(startupTimeoutInput)
            ? Number(startupTimeoutInput)
            : undefined;
        const logs = Object.fromEntries(
          Object.entries(diagnostics?.logs ?? {}).map(([name, record]) => [
            name,
            { status: record.status, sizeBytes: record.sizeBytes, diagnostic: record.diagnostic },
          ]),
        );
        const evidence = {
          schemaVersion: 'revo-real-installer-failure/v1',
          checkpoint,
          channel,
          installerCode: installerCode ?? null,
          installerSignal,
          installerOutcome,
          elapsedMs: Math.round(performance.now() - installationStartedAt),
          cleanupError:
            cleanupError instanceof Error
              ? sanitizeInitialDiagnostic({ status: 'complete', text: cleanupError.message }, [
                  subject.root,
                ])
              : cleanupError === undefined
                ? null
                : 'non-error cleanup failure',
          status: { kind: 'not-observed-by-snapshot' },
          startupTimeoutMs:
            startupTimeoutMs ?? (startupTimeoutInput === undefined ? 180_000 : null),
          lifecycle: { status: 'see bounded sanitized server-start log' },
          diagnosticsReused,
          installDiagnostics: diagnostics
            ? { status: diagnostics.status, reason: diagnostics.reason, logs }
            : { status: 'incomplete', reason: 'collection-unavailable', logs },
        };
        const line = JSON.stringify(evidence);
        const prefix = 'REVO_REAL_INSTALLER_FAILURE ';
        const boundedLine =
          Buffer.byteLength(`${prefix}${line}\n`, 'utf8') <= 16_384
            ? line
            : JSON.stringify({
                schemaVersion: 'revo-real-installer-failure/v1',
                checkpoint,
                channel,
                installerCode: installerCode ?? null,
                installerSignal,
                installerOutcome,
                elapsedMs: Math.round(performance.now() - installationStartedAt),
                snapshotStatus: 'incomplete-size-limit',
                diagnosticsReused,
              });
        console.error(`${prefix}${boundedLine}`);
      } catch {
        console.error(
          `REVO_REAL_INSTALLER_FAILURE ${JSON.stringify({
            schemaVersion: 'revo-real-installer-failure/v1',
            checkpoint,
            channel,
            installerCode: installerCode ?? null,
            installerSignal,
            installerOutcome,
            elapsedMs: Math.round(performance.now() - installationStartedAt),
            snapshotStatus: 'incomplete',
            diagnosticsReused,
          })}`,
        );
      }
    };
    await runWithPortableToolchainCleanup(
      subject.root,
      async () => {
        expect(subject.plan.release.version).toMatch(/^0\.0\./u);
        const installation = subject.startInstaller();
        const installationCode = await finishInitialInstallWithDiagnostics(
          channel === 'stable' ? 'real-stable-activation-mode' : 'real-alpha-activation-mode',
          subject.root,
          installation,
          (signal, markCloseUncertain) =>
            subject.initialInstallFailureDiagnostics(signal, markCloseUncertain),
          undefined,
          5_000,
          realpath,
          (diagnostics) => {
            initialFailureDiagnostics = diagnostics;
          },
        );
        installerOutcome = formatInstallerOutcome(installation.outcome());
        installerStderrTail = installation.stderrTail();
        installerSignal = installation.outcome()?.signal ?? null;
        if (installationCode !== 0) {
          await emitFailureSnapshot(
            'installer-failed',
            installationCode,
            initialFailureDiagnostics,
          );
        }
        expect(installationCode).toBe(0);
        phase = 'initial-server-status';
        const running = await subject.status();
        expect(running.kind).toBe('running');
        expect(installation.stdout()).toContain('http://127.0.0.1:');
        expect(installation.stdout()).toContain('Command now:');
        const downloads = await readFile(subject.calls, 'utf8');
        const artifactRequests = await readFile(subject.fetchCalls, 'utf8');
        const pnpmInvocations = await readFile(subject.pnpmCalls, 'utf8');
        expect(pnpmInvocations.trim().length).toBeGreaterThan(0);
        const current = validActivation(await readActivation(join(subject.root, 'state', channel)));
        expect(current.record.release.version).toBe(subject.plan.release.version);
        expect(current.record.toolchain.nodeArchiveSha256).toBe(subject.nodeArchiveSha256);
        expect(current.record.toolchain.pnpmArchiveSha256).toBe(subject.pnpmArchiveSha256);
        expect(current.record.launcherProtocol).toBe('revo-activation-launcher/v2');
        const generation = current.record.generationId;
        phase = 'same-version-reuse';
        const reuse = subject.startInstaller();
        const reuseCode = await reuse.finish;
        installerOutcome = formatInstallerOutcome(reuse.outcome());
        installerStderrTail = reuse.stderrTail();
        expect(reuseCode).toBe(0);
        expect(await subject.status()).toEqual(running);
        expect(await readFile(subject.calls, 'utf8')).toBe(downloads);
        expect(await readFile(subject.fetchCalls, 'utf8')).toBe(artifactRequests);
        expect(await readFile(subject.pnpmCalls, 'utf8')).toBe(pnpmInvocations);
        const retry = validActivation(await readActivation(join(subject.root, 'state', channel)));
        expect(retry.record.generationId).toBe(generation);
      },
      async () => {
        try {
          await cleanupPortableToolchain(subject.root);
        } catch (error) {
          await emitFailureSnapshot(
            'cleanup-failed',
            undefined,
            initialFailureDiagnostics,
            error,
            true,
          );
          throw new Error(
            `cleanup phase failed; testPhase=${phase}; installer=${installerOutcome}; ` +
              `stderrTail=${installerStderrTail.slice(-1024)}`,
            { cause: error },
          );
        }
      },
    );
  },
  180_000,
);

function formatInstallerOutcome(
  outcome: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined,
): string {
  return outcome
    ? `code=${outcome.code ?? 'null'}; signal=${outcome.signal ?? 'none'}`
    : 'exit-not-observed';
}

const recoveryActivationSummary = async (channelRoot: string) => {
  try {
    const activation = await readActivation(channelRoot);
    if (activation.status !== 'valid') {
      return { status: activation.status };
    }
    return {
      status: 'valid' as const,
      generationId: activation.record.generationId,
      releaseVersion: activation.record.release.version,
    };
  } catch {
    return {
      status: 'read-error' as const,
    };
  }
};

const recoveryPostgresObserver = async (path: string | undefined, fixtureRoot: string) => {
  if (path === undefined) {
    return 'observer-not-requested';
  }
  try {
    const text = await readFile(path, 'utf8');
    return text
      .replaceAll(fixtureRoot, '<fixture>')
      .replace(/\b(postgres(?:ql)?:\/\/)[^\s/@]+@/giu, '$1[redacted]@')
      .replace(
        /\b(password|secret|token|authorization|cookie)(\s*[:=]\s*)(["']?)[^\s,;"']+/giu,
        '$1$2[redacted]',
      )
      .slice(-16 * 1024);
  } catch {
    return 'observer-unavailable';
  }
};

const boundedProcessSnapshot = (command: string, args: readonly string[]) =>
  new Promise<{ readonly status: string; readonly output: string }>((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (status: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ status, output });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish('timeout');
    }, 2000);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (Buffer.byteLength(output) >= 64 * 1024) {
        return;
      }
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      const remaining = 64 * 1024 - Buffer.byteLength(output);
      output += text.slice(-remaining);
    });
    child.once('error', () => finish('error'));
    child.once('close', (code, signal) =>
      finish(
        signal === null && code === 0 ? 'captured' : `exit-${code ?? 'null'}-${signal ?? 'none'}`,
      ),
    );
  });

const recoveryRuntimeSnapshot = async (input: {
  readonly phase: string;
  readonly dataDir: string;
  readonly redactionRoots: readonly string[];
  readonly status?: string;
}): Promise<void> => {
  const clusterDir = join(input.dataDir, 'postgres');
  let postmaster: Record<string, unknown>;
  try {
    const path = join(clusterDir, 'postmaster.pid');
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      postmaster = { status: 'unsafe' };
    } else {
      const lines = (await readFile(path, 'utf8')).split('\n');
      postmaster = {
        status: 'captured',
        mode: (metadata.mode & 0o777).toString(8),
        pid: /^\d+$/u.test(lines[0] ?? '') ? lines[0] : 'invalid',
        startTime: lines[2] ?? 'missing',
        port: /^\d+$/u.test(lines[3] ?? '') ? lines[3] : 'invalid',
        sharedMemoryKey: /^\d+$/u.test(lines[6] ?? '') ? lines[6] : 'invalid',
        sharedMemoryId: /^\d+$/u.test(lines[7] ?? '') ? lines[7] : 'invalid',
      };
    }
  } catch {
    postmaster = { status: 'missing-or-unavailable' };
  }
  const version = await readFile(join(clusterDir, 'PG_VERSION'), 'utf8')
    .then((value) => value.trim().slice(0, 32))
    .catch(() => 'missing-or-unavailable');
  const processes = await boundedProcessSnapshot('ps', [
    '-eo',
    'pid=,ppid=,pgid=,sid=,etimes=,stat=,comm=,args=',
  ]);
  const roots = [...input.redactionRoots].sort((left, right) => right.length - left.length);
  const relevantProcesses = processes.output
    .split('\n')
    .filter((line) => /postgres|revo-server|revo-core/iu.test(line))
    .map((line) => roots.reduce((value, root) => value.replaceAll(root, '<fixture>'), line))
    .slice(0, 64);
  console.error(
    `REVO_RECOVERY_SNAPSHOT ${JSON.stringify({
      phase: input.phase,
      status: input.status ?? 'not-read',
      cluster: roots.reduce((value, root) => value.replaceAll(root, '<fixture>'), clusterDir),
      pgVersion: version,
      postmaster,
      processListing: { status: processes.status, entries: relevantProcesses },
    })}`,
  );
};

async function reportRecoveryAttempt(input: {
  readonly phase: string;
  readonly fixtureRoot: string;
  readonly channelRoot: string;
  readonly attemptName?: string;
  readonly postgresObserverPath?: string;
  readonly expectedCandidateVersion: string;
  readonly expectedGenerationId: string;
  readonly installer: {
    readonly finishCode: number;
    readonly outcome: () =>
      | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
      | undefined;
    readonly stdoutTail: () => string;
    readonly stderrTail: () => string;
  };
}): Promise<void> {
  let diagnostics = 'collection-not-run';
  try {
    diagnostics = input.attemptName
      ? await collectInstallAttemptDiagnostics(
          input.fixtureRoot,
          input.channelRoot,
          input.attemptName,
        )
      : await collectInitialInstallFailureDiagnostics(input.fixtureRoot, input.channelRoot);
  } catch {
    diagnostics = 'collection-failed';
  }
  console.error(
    `REVO_RECOVERY_DIAGNOSTIC ${JSON.stringify({
      phase: input.phase,
      finishCode: input.installer.finishCode,
      outcome: formatInstallerOutcome(input.installer.outcome()),
      expectedCandidateVersion: input.expectedCandidateVersion,
      expectedGenerationId: input.expectedGenerationId,
      attemptName: input.attemptName ?? 'attempt-unresolved',
      activation: await recoveryActivationSummary(input.channelRoot),
      postgresObserver: await recoveryPostgresObserver(
        input.postgresObserverPath,
        input.fixtureRoot,
      ),
      stdoutTail: input.installer.stdoutTail(),
      stderrTail: input.installer.stderrTail(),
      installDiagnostics: diagnostics,
    })}`,
  );
}

type InitialInstallExecution = {
  readonly finish: Promise<number>;
  readonly outcome: () =>
    | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
    | undefined;
};

async function finishInitialInstallWithDiagnostics(
  testCase: InitialInstallFailureTestCase,
  fixtureRoot: string,
  installation: InitialInstallExecution,
  collect: (
    signal: AbortSignal,
    markCloseUncertain: () => void,
  ) => Promise<InitialInstallDiagnostics>,
  report: (message: string) => void = (message) => console.error(message),
  timeoutMs = 5_000,
  resolveDiagnosticRoot: (path: string) => Promise<string> = realpath,
  onDiagnostics?: (diagnostics: InitialInstallDiagnostics) => void,
): Promise<number> {
  const finishCode = await installation.finish;
  if (finishCode !== 0) {
    try {
      let diagnostics: InitialInstallDiagnostics = {
        status: 'incomplete',
        reason: 'collector-error',
        logs: {
          'install-session.log': {
            status: 'incomplete',
            sizeBytes: null,
            diagnostic: '[diagnostic omitted]',
          },
          'server-start.log': {
            status: 'incomplete',
            sizeBytes: null,
            diagnostic: '[diagnostic omitted]',
          },
          'activation-result.log': {
            status: 'incomplete',
            sizeBytes: null,
            diagnostic: '[diagnostic omitted]',
          },
        },
      };
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let currentLease: InitialDiagnosticCollectionLease<InitialInstallDiagnostics> | undefined;
      try {
        let timedOut = false;
        const deadline = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            currentLease?.abort();
            resolve({ kind: 'timeout' });
          }, timeoutMs);
        });
        currentLease = startInitialDiagnosticCollection(
          fixtureRoot,
          collect,
          resolveDiagnosticRoot,
        );
        const collection = currentLease.promise.then(
          (value) => ({ kind: 'complete' as const, value }),
          () => ({ kind: 'failed' as const }),
        );
        const result = await Promise.race([collection, deadline]);
        if (result.kind === 'complete') {
          diagnostics = result.value;
        } else if (result.kind === 'timeout') {
          currentLease.abort();
        } else if (timedOut) {
          currentLease.abort();
        }
      } catch {
        // Diagnostics are best-effort and cannot replace the installer failure.
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
      let signal: string | null = null;
      try {
        signal = installation.outcome()?.signal ?? null;
      } catch {
        // Keep the receipt valid even if a diagnostic accessor fails.
      }
      const platform =
        process.platform === 'linux' || process.platform === 'darwin'
          ? process.platform
          : 'unknown';
      const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : 'unknown';
      try {
        onDiagnostics?.(diagnostics);
      } catch {
        // Snapshot capture must not replace the installer failure.
      }
      const receipt = serializeInitialInstallFailureReceipt({
        testCase,
        platform,
        arch,
        finishCode,
        signal,
        stdoutDiagnostic: { status: 'incomplete' },
        stderrDiagnostic: { status: 'incomplete' },
        diagnostics,
      });
      report(receipt);
    } catch {
      // Serialization or reporting failure is swallowed; never invoke a broken reporter twice.
    }
  }
  return finishCode;
}

async function runWithCleanupPreservingFailure<T>(
  run: () => Promise<T>,
  cleanups: readonly (() => Promise<void>)[],
): Promise<T> {
  let value!: T;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    value = await run();
  } catch (error) {
    primaryFailure = error;
    hasPrimaryFailure = true;
  }

  const cleanupFailures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- continue after each failure and preserve cleanup order.
      await cleanup();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (hasPrimaryFailure && cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      'Scenario and one or more independent cleanup steps failed',
    );
  }
  if (hasPrimaryFailure) {
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'One or more independent cleanup steps failed');
  }
  return value;
}

describe('pinned pnpm fixture archive fetch', () => {
  const url = 'https://github.com/pnpm/pnpm/releases/download/v12.5.1/pnpm-fixture.tar.gz';
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  it('retries one transient 5xx and verifies the pinned bytes', async () => {
    let firstBodyCancelled = false;
    const transientBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('transient'));
      },
      cancel() {
        firstBodyCancelled = true;
      },
    });
    const request = vi
      .fn<typeof fetch>(async () => new Response(transientBody, { status: 500 }))
      .mockResolvedValueOnce(new Response(transientBody, { status: 500 }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    const attempts: Array<{
      attempt: number;
      status: number | 'network-error';
      durationMs: number;
    }> = [];

    const result = await fetchPinnedPnpmFixtureArchive({
      url,
      sha256,
      request,
      retryDelayMs: 1,
      onAttempt: (attempt) => attempts.push(attempt),
    });

    expect(result).toEqual(bytes);
    expect(request).toHaveBeenCalledTimes(2);
    expect(firstBodyCancelled).toBe(true);
    expect(attempts.map(({ attempt, status }) => [attempt, status])).toEqual([
      [1, 500],
      [2, 200],
    ]);
    expect(attempts.every(({ durationMs }) => durationMs >= 0)).toBe(true);
  });

  it('does not retry a second transient 5xx', async () => {
    const request = vi
      .fn<typeof fetch>(async () => new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('still unavailable', { status: 503 }));
    const attempts: number[] = [];

    await expect(
      fetchPinnedPnpmFixtureArchive({
        url,
        sha256,
        request,
        retryDelayMs: 1,
        onAttempt: ({ status }) => {
          if (typeof status === 'number') {
            attempts.push(status);
          }
        },
      }),
    ).rejects.toThrow('pnpm archive download failed: 503');
    expect(request).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual([503, 503]);
  });

  it('does not retry checksum mismatch or non-retryable status', async () => {
    const wrongDigestRequest = vi.fn<typeof fetch>(
      async () => new Response('wrong', { status: 200 }),
    );
    await expect(
      fetchPinnedPnpmFixtureArchive({ url, sha256, request: wrongDigestRequest }),
    ).rejects.toThrow('pnpm archive digest mismatch');
    expect(wrongDigestRequest).toHaveBeenCalledTimes(1);

    const notFoundRequest = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    await expect(
      fetchPinnedPnpmFixtureArchive({ url, sha256, request: notFoundRequest, retryDelayMs: 1 }),
    ).rejects.toThrow('pnpm archive download failed: 404');
    expect(notFoundRequest).toHaveBeenCalledTimes(1);
  });

  it('applies one overall deadline to retry delay and requests', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('unavailable', { status: 500 }));
    await expect(
      fetchPinnedPnpmFixtureArchive({
        url,
        sha256,
        request,
        timeoutMs: 20,
        retryDelayMs: 100,
      }),
    ).rejects.toBeDefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('bounds a request that never resolves response headers', async () => {
    const request = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const attempts: string[] = [];

    await expect(
      fetchPinnedPnpmFixtureArchive({
        url,
        sha256,
        request,
        timeoutMs: 10,
        onAttempt: ({ status }) => attempts.push(String(status)),
      }),
    ).rejects.toBeDefined();

    expect(request).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual(['network-error']);
  });

  it('cancels a response whose headers arrive after the overall timeout', async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('late response'));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const request = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    await expect(
      fetchPinnedPnpmFixtureArchive({ url, sha256, request, timeoutMs: 10 }),
    ).rejects.toBeDefined();
    resolveRequest?.(new Response(body, { status: 500 }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(bodyCancelled).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('bounds a successful response whose body never completes', async () => {
    let rejectBody: ((error: Error) => void) | undefined;
    const stalledBody = new ReadableStream<Uint8Array>({
      pull: () =>
        new Promise<void>((_resolve, reject) => {
          rejectBody = reject;
        }),
    });
    const request = vi.fn<typeof fetch>(async () => new Response(stalledBody, { status: 200 }));

    await expect(
      fetchPinnedPnpmFixtureArchive({ url, sha256, request, timeoutMs: 10 }),
    ).rejects.toBeDefined();
    rejectBody?.(new Error('late body rejection'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['stalled', 'rejected'] as const)(
    'does not retry a transient response when body cancellation is %s',
    async (cancelMode) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('transient'));
        },
        cancel() {
          return cancelMode === 'stalled'
            ? new Promise<void>(() => undefined)
            : Promise.reject(new Error('cancel failed'));
        },
      });
      const request = vi.fn<typeof fetch>(async () => new Response(body, { status: 500 }));
      await expect(
        fetchPinnedPnpmFixtureArchive({ url, sha256, request, timeoutMs: 20, retryDelayMs: 1 }),
      ).rejects.toThrow('pnpm archive response cancellation failed');
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry a network rejection or a wrong digest after one 5xx', async () => {
    const networkError = new Error('network unavailable');
    const rejectedRequest = vi.fn<typeof fetch>(async () => {
      throw networkError;
    });
    await expect(
      fetchPinnedPnpmFixtureArchive({ url, sha256, request: rejectedRequest, retryDelayMs: 1 }),
    ).rejects.toBe(networkError);
    expect(rejectedRequest).toHaveBeenCalledTimes(1);

    const wrongBytes = new Uint8Array([9, 8, 7]);
    const wrongDigestRequest = vi
      .fn<typeof fetch>(async () => new Response('unavailable', { status: 500 }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 500 }))
      .mockResolvedValueOnce(new Response(wrongBytes, { status: 200 }));
    await expect(
      fetchPinnedPnpmFixtureArchive({
        url,
        sha256,
        request: wrongDigestRequest,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow('pnpm archive digest mismatch');
    expect(wrongDigestRequest).toHaveBeenCalledTimes(2);
  });
});

describe('initial installation failure diagnostics', () => {
  it('keeps the scenario error first and runs every independent cleanup after failures', async () => {
    const primary = new Error('original installation assertion');
    const cleanupFailure = new Error('server cleanup failed');
    const events: string[] = [];

    const outcome = runWithCleanupPreservingFailure(async () => {
      events.push('scenario');
      throw primary;
    }, [
      async () => {
        events.push('cleanup-one');
        throw cleanupFailure;
      },
      async () => {
        events.push('cleanup-two');
      },
    ]);

    await expect(outcome).rejects.toMatchObject({ errors: [primary, cleanupFailure] });
    expect(events).toEqual(['scenario', 'cleanup-one', 'cleanup-two']);
  });

  it('collects only after an unexpected failure and preserves the installer result', async () => {
    const events: string[] = [];
    const report = vi.fn<(message: string) => void>();
    const success = {
      finish: Promise.resolve(0),
      outcome: () => ({ code: 0, signal: null }),
      stdoutTail: () => '',
      stderrTail: () => '',
    };
    const collect = vi.fn<() => Promise<InitialInstallDiagnostics>>(async () => {
      events.push('collect');
      throw new Error('collector failure');
    });

    expect(
      await finishInitialInstallWithDiagnostics(
        'real-stable-activation-mode',
        process.cwd(),
        success,
        collect,
        report,
      ),
    ).toBe(0);
    expect(collect).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();

    const failure = { ...success, finish: Promise.resolve(1) };
    expect(
      await finishInitialInstallWithDiagnostics(
        'real-stable-activation-mode',
        process.cwd(),
        failure,
        collect,
        report,
      ),
    ).toBe(1);
    events.push('cleanup');
    expect(events).toEqual(['collect', 'cleanup']);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toContain('"finishCode":1');
    expect(report.mock.calls[0]?.[0]).toContain('"reason":"collector-error"');
    expect(report.mock.calls[0]?.[0]).not.toContain('collector failure');
  });

  it('preserves a rejected finish and never lets diagnostic getters or reporting replace its code', async () => {
    const finishFailure = new Error('installer finish rejection');
    await expect(
      finishInitialInstallWithDiagnostics(
        'real-stable-activation-mode',
        process.cwd(),
        {
          finish: Promise.reject(finishFailure),
          outcome: () => undefined,
        },
        async () => ({
          status: 'incomplete',
          reason: 'collector-error',
          logs: {
            'install-session.log': {
              status: 'incomplete',
              sizeBytes: null,
              diagnostic: '[diagnostic omitted]',
            },
            'server-start.log': {
              status: 'incomplete',
              sizeBytes: null,
              diagnostic: '[diagnostic omitted]',
            },
            'activation-result.log': {
              status: 'incomplete',
              sizeBytes: null,
              diagnostic: '[diagnostic omitted]',
            },
          },
        }),
      ),
    ).rejects.toBe(finishFailure);

    const report = vi.fn<(message: string) => void>(() => {
      throw new Error('reporter failure');
    });
    const installation = {
      finish: Promise.resolve(23),
      get outcome(): InitialInstallExecution['outcome'] {
        throw new Error('outcome accessor failure');
      },
    };
    await expect(
      finishInitialInstallWithDiagnostics(
        'real-stable-activation-mode',
        process.cwd(),
        installation,
        async () => {
          throw new Error('collector rejection');
        },
        report,
      ),
    ).resolves.toBe(23);
    expect(report).toHaveBeenCalledTimes(1);
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'revo-initial-diagnostics-'));
    const channelRoot = join(root, 'state', 'stable');
    const scratch = join(channelRoot, '.attempt.Abc123', 'runtime', 'scratch');
    const activation = join(scratch, '.activation-request-Def456');
    await mkdir(activation, { recursive: true, mode: 0o700 });
    return { root, channelRoot, scratch, activation };
  }

  it('reads only fixed logs and omits an entire credential-bearing or unsafe log', async () => {
    const subject = await fixture();
    try {
      await writeFile(
        join(subject.scratch, 'install-session.log'),
        `activation failed password=super-secret ${subject.root}\n`,
      );
      await writeFile(join(subject.scratch, 'server-start.log'), 'server did not start\n');
      await writeFile(
        join(subject.activation, 'result.log'),
        '\u001b[31m::error::activation helper failed token=other-secret\u001b[0m\n',
      );
      await writeFile(join(subject.scratch, 'unlisted-secret.log'), 'must never appear\n');

      const output = await collectInitialInstallFailureDiagnostics(
        subject.root,
        subject.channelRoot,
      );

      expect(output).toContain('install-session.log status=captured');
      expect(output).toContain('server-start.log status=captured');
      expect(output).toContain('activation-result.log status=captured');
      expect(output).toContain('server did not start');
      expect(output).toContain('install-session.log | "[diagnostic omitted]"');
      expect(output).toContain('activation-result.log | "[diagnostic omitted]"');
      expect(output).not.toContain('super-secret');
      expect(output).not.toContain('other-secret');
      expect(output).not.toContain(subject.root);
      expect(output).not.toContain('unlisted-secret');
      expect(output).not.toContain('\u001b');
      expect(
        output
          .split('\n')
          .filter(Boolean)
          .every((line) => line.startsWith('POSIX_INSTALL_DIAGNOSTIC ')),
      ).toBe(true);
      expect(output.split('\n').some((line) => line.startsWith('::'))).toBe(false);
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it('omits oversized diagnostic fields instead of publishing a partial tail', async () => {
    const subject = await fixture();
    try {
      const large = `${'x'.repeat(10_000)}\nfinal-evidence-line\n`;
      await writeFile(join(subject.scratch, 'install-session.log'), large);
      await writeFile(join(subject.scratch, 'server-start.log'), large);
      await writeFile(join(subject.activation, 'result.log'), large);

      const output = await collectInitialInstallFailureDiagnostics(
        subject.root,
        subject.channelRoot,
      );

      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(16 * 1024);
      expect(output).toContain(`sizeBytes=${Buffer.byteLength(large, 'utf8')}`);
      expect(output).toContain('install-session.log | "[diagnostic omitted]"');
      expect(output).not.toContain('final-evidence-line');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it('reports missing and ambiguous attempts or activation request directories without guessing', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'revo-initial-diagnostics-missing-'));
    const missingChannel = join(missing, 'state', 'stable');
    await mkdir(missingChannel, { recursive: true, mode: 0o700 });
    try {
      const missingOutput = await collectInitialInstallFailureDiagnostics(missing, missingChannel);
      expect(missingOutput).toContain('reason=attempts-unavailable');

      const logsMissing = await fixture();
      try {
        const output = await collectInitialInstallFailureDiagnostics(
          logsMissing.root,
          logsMissing.channelRoot,
        );
        expect(output).toContain('status=complete reason=none');
        expect(output).toContain('install-session.log status=missing');
        expect(output).toContain('server-start.log status=missing');
        expect(output).toContain('activation-result.log status=missing');
        expect(output).not.toContain('reason=collector-error');
      } finally {
        await rm(logsMissing.root, { recursive: true, force: true });
      }

      const subject = await fixture();
      try {
        await mkdir(join(subject.channelRoot, '.attempt.Other789', 'runtime', 'scratch'), {
          recursive: true,
          mode: 0o700,
        });
        expect(
          await collectInitialInstallFailureDiagnostics(subject.root, subject.channelRoot),
        ).toContain('reason=attempts-ambiguous');
      } finally {
        await rm(subject.root, { recursive: true, force: true });
      }

      const activationAmbiguous = await fixture();
      try {
        await mkdir(join(activationAmbiguous.scratch, '.activation-request-Other789'));
        const output = await collectInitialInstallFailureDiagnostics(
          activationAmbiguous.root,
          activationAmbiguous.channelRoot,
        );
        expect(output).toContain('activation-result.log status=ambiguous');
      } finally {
        await rm(activationAmbiguous.root, { recursive: true, force: true });
      }
    } finally {
      await rm(missing, { recursive: true, force: true });
    }
  });

  it('rejects symlink log files and symlink parent directories', async () => {
    const subject = await fixture();
    const outside = join(subject.root, 'outside.log');
    try {
      await writeFile(outside, 'outside-secret\n');
      await symlink(outside, join(subject.scratch, 'install-session.log'));
      await writeFile(join(subject.scratch, 'server-start.log'), 'safe\n');
      await writeFile(join(subject.activation, 'result.log'), 'safe\n');

      const output = await collectInitialInstallFailureDiagnostics(
        subject.root,
        subject.channelRoot,
      );
      expect(output).toContain('install-session.log status=unsafe');
      expect(output).not.toContain('outside-secret');

      await rm(join(subject.scratch, '.activation-request-Def456'), { recursive: true });
      await rm(join(subject.scratch, 'server-start.log'));
      await rm(join(subject.scratch, 'install-session.log'));
      await rm(join(subject.scratch, '.activation-request-Def456'), { force: true });
      const externalScratch = join(subject.root, 'external-scratch');
      await mkdir(externalScratch);
      await writeFile(join(externalScratch, 'install-session.log'), 'outside-secret\n');
      await rm(join(subject.channelRoot, '.attempt.Abc123', 'runtime'), { recursive: true });
      await symlink(externalScratch, join(subject.channelRoot, '.attempt.Abc123', 'runtime'));

      const parentOutput = await collectInitialInstallFailureDiagnostics(
        subject.root,
        subject.channelRoot,
      );
      expect(parentOutput).toContain('status=incomplete reason=scratch-unavailable');
      expect(parentOutput).toContain('install-session.log status=unsafe');
      expect(parentOutput).not.toContain('outside-secret');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it('marks named-attempt diagnostics incomplete for invalid UTF-8 and accepts missing logs', async () => {
    const subject = await fixture();
    const attemptName = '.attempt.Abc123';
    const logPath = join(
      subject.channelRoot,
      attemptName,
      'runtime',
      'scratch',
      'install-session.log',
    );
    try {
      const missingOutput = await collectInstallAttemptDiagnostics(
        subject.root,
        subject.channelRoot,
        attemptName,
      );
      expect(missingOutput).toContain('status=complete attempt=.attempt.Abc123');

      await writeFile(logPath, Buffer.from([0xff, 0xfe, 0xfd]));
      const invalidUtf8Output = await collectInstallAttemptDiagnostics(
        subject.root,
        subject.channelRoot,
        attemptName,
      );

      expect(invalidUtf8Output).toContain('status=diagnostics-incomplete attempt=.attempt.Abc123');
      expect(invalidUtf8Output).toContain('install-session.log status=invalid-utf8');
      expect(invalidUtf8Output).not.toContain('�');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it('does not select directory entries returned after collection is aborted at its bound', async () => {
    const subject = await fixture();
    const controller = new AbortController();
    let entryReads = 0;
    try {
      await Promise.all(
        Array.from({ length: 63 }, (_, index) =>
          writeFile(join(subject.channelRoot, `unrelated-${index}`), ''),
        ),
      );
      const diagnostics = await collectInitialInstallFailureRecords(
        subject.root,
        subject.channelRoot,
        controller.signal,
        async (event) => {
          if (event.phase === 'directory-entry-read') {
            entryReads += 1;
            if (entryReads === 64) {
              controller.abort();
            }
          }
        },
      );

      expect(entryReads).toBe(64);
      expect(diagnostics.status).toBe('incomplete');
      expect(diagnostics.reason).toBe('attempts-unavailable');
      expect(Object.values(diagnostics.logs).every((record) => record.status === 'io-error')).toBe(
        true,
      );
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it('does not choose a single activation request from a truncated directory listing', async () => {
    const subject = await fixture();
    try {
      await writeFile(join(subject.activation, 'result.log'), 'must-not-be-selected');
      await Promise.all(
        Array.from({ length: 63 }, (_, index) =>
          writeFile(join(subject.scratch, `unrelated-${index}`), ''),
        ),
      );
      const diagnostics = await collectInitialInstallFailureRecords(
        subject.root,
        subject.channelRoot,
      );

      expect(diagnostics.status).toBe('incomplete');
      expect(diagnostics.reason).toBe('activation-request-ambiguous');
      expect(diagnostics.logs['activation-result.log']).toMatchObject({
        status: 'ambiguous',
        sizeBytes: null,
        diagnostic: '[diagnostic omitted]',
      });
      expect(JSON.stringify(diagnostics)).not.toContain('must-not-be-selected');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it('omits multibyte fields that exceed the per-field UTF-8 output bound', async () => {
    const subject = await fixture();
    try {
      const dense = 'é\n'.repeat(4096);
      await writeFile(join(subject.scratch, 'install-session.log'), dense);
      await writeFile(join(subject.scratch, 'server-start.log'), dense);
      await writeFile(join(subject.activation, 'result.log'), dense);

      const output = await collectInitialInstallFailureDiagnostics(
        subject.root,
        subject.channelRoot,
      );
      const lines = output.split('\n').filter(Boolean);

      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(16 * 1024);
      expect(output).toContain('install-session.log | "[diagnostic omitted]"');
      expect(output).not.toContain(' | é');
      expect(lines.every((line) => line.startsWith('POSIX_INSTALL_DIAGNOSTIC '))).toBe(true);
      expect(output).not.toContain('\uFFFD');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it('omits a whole log when controls split a credential indicator', async () => {
    const subject = await fixture();
    try {
      await writeFile(
        join(subject.scratch, 'install-session.log'),
        'pass\u001b[31mword=escape-secret\n',
      );

      const output = await collectInitialInstallFailureDiagnostics(
        subject.root,
        subject.channelRoot,
      );

      expect(output).toContain('install-session.log | "[diagnostic omitted]"');
      expect(output).not.toContain('escape-secret');
      expect(output).not.toContain('\u001b');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it('rejects oversized and invalid UTF-8 captures without exposing any remainder', async () => {
    const subject = await fixture();
    try {
      await writeFile(join(subject.scratch, 'install-session.log'), 'x'.repeat(16 * 1024));
      let output = await collectInitialInstallFailureDiagnostics(subject.root, subject.channelRoot);
      expect(output).toContain('install-session.log status=captured sizeBytes=16384');
      expect(output).toContain('install-session.log | "[diagnostic omitted]"');

      await writeFile(join(subject.scratch, 'install-session.log'), 'x'.repeat(16 * 1024 + 1));
      output = await collectInitialInstallFailureDiagnostics(subject.root, subject.channelRoot);
      expect(output).toContain('install-session.log status=too-large sizeBytes=16385');
      expect(output).not.toContain('x'.repeat(100));

      await writeFile(join(subject.scratch, 'install-session.log'), Buffer.from([0xc3, 0x28]));
      output = await collectInitialInstallFailureDiagnostics(subject.root, subject.channelRoot);
      expect(output).toContain('install-session.log status=invalid-utf8 sizeBytes=2');
      expect(output).not.toContain('\uFFFD');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it.each(['symlink', 'directory'] as const)(
    'fails closed when a validated parent is replaced by a %s before leaf access',
    async (replacementKind) => {
      const subject = await fixture();
      const replacement = await mkdtemp(join(tmpdir(), 'revo-diagnostic-outside-'));
      const runtime = dirname(subject.scratch);
      const preservedRuntime = join(subject.root, 'runtime-preserved');
      try {
        await writeFile(join(subject.scratch, 'install-session.log'), 'INSIDE_SENTINEL\n');
        await writeFile(join(replacement, 'install-session.log'), 'OUTSIDE_SENTINEL\n');
        let replaced = false;
        const output = await collectInitialInstallFailureDiagnostics(
          subject.root,
          subject.channelRoot,
          undefined,
          async (event) => {
            if (
              event.phase !== 'parents-validated' ||
              event.label !== 'install-session.log' ||
              replaced
            ) {
              return;
            }
            replaced = true;
            await rename(runtime, preservedRuntime);
            if (replacementKind === 'symlink') {
              await symlink(replacement, runtime);
              return;
            }
            await mkdir(join(runtime, 'scratch'), { recursive: true });
            await writeFile(join(runtime, 'scratch', 'install-session.log'), 'OUTSIDE_SENTINEL\n');
          },
        );

        expect(replaced).toBe(true);
        expect(output).toContain('status=incomplete');
        expect(output).toContain('reason=directory-identity-changed');
        expect(output).not.toContain('INSIDE_SENTINEL');
        expect(output).not.toContain('OUTSIDE_SENTINEL');
      } finally {
        await rm(subject.root, { recursive: true, force: true });
        await rm(replacement, { recursive: true, force: true });
      }
    },
  );

  it('rejects a same-size rewrite performed after the bounded file read', async () => {
    const subject = await fixture();
    try {
      const logPath = join(subject.scratch, 'install-session.log');
      await writeFile(logPath, 'BEFORE\n');
      let rewritten = false;
      const output = await collectInitialInstallFailureDiagnostics(
        subject.root,
        subject.channelRoot,
        undefined,
        async (event) => {
          if (event.phase === 'file-read' && event.label === 'install-session.log' && !rewritten) {
            rewritten = true;
            await writeFile(logPath, 'AFTER!\n');
          }
        },
      );

      expect(rewritten).toBe(true);
      expect(output).toContain('install-session.log status=incomplete');
      expect(output).not.toContain('BEFORE');
      expect(output).not.toContain('AFTER!');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it('keeps the final failure receipt one-line, bounded, and secret-free end to end', async () => {
    const subject = await fixture();
    try {
      await writeFile(
        join(subject.scratch, 'install-session.log'),
        'application-bootstrap failed: ECONNREFUSED\n',
      );
      await writeFile(join(subject.scratch, 'server-start.log'), 'password=receipt-secret\n');
      await writeFile(
        join(subject.activation, 'result.log'),
        'https://alice:receipt-url-secret@example.invalid/path?signature=receipt-query-secret\n',
      );
      const diagnostics = await collectInitialInstallFailureRecords(
        subject.root,
        subject.channelRoot,
      );
      const receipt = serializeInitialInstallFailureReceipt({
        testCase: 'real-stable-activation-mode',
        platform: 'linux',
        arch: 'x64',
        finishCode: 17,
        signal: null,
        stdoutDiagnostic: { status: 'incomplete' },
        stderrDiagnostic: { status: 'incomplete' },
        diagnostics,
      });
      expect(receipt).not.toContain('\n');
      expect(Buffer.byteLength(`${receipt}\n`, 'utf8')).toBeLessThanOrEqual(24 * 1024);
      expect(JSON.parse(receipt.slice('REVO_INITIAL_INSTALL_FAILURE '.length))).toMatchObject({
        finishCode: 17,
        diagnostics: expect.objectContaining({
          status: 'complete',
          logs: expect.objectContaining({
            'install-session.log': expect.objectContaining({
              status: 'captured',
              diagnostic: 'application-bootstrap failed: ECONNREFUSED',
            }),
            'server-start.log': expect.objectContaining({
              status: 'captured',
              diagnostic: '[diagnostic omitted]',
            }),
            'activation-result.log': expect.objectContaining({
              status: 'captured',
              diagnostic: 'URL origin scheme=https host=example.invalid port=443',
            }),
          }),
        }),
      });
      expect(receipt).not.toContain('receipt-secret');
      expect(receipt).not.toContain('receipt-url-secret');
      expect(receipt).not.toContain('receipt-query-secret');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it.each([
    { line: '_authToken=abc123', redacted: true },
    { line: 'config:NPM_TOKEN=abc123', redacted: true },
    { line: 'config:clientSecret=abc123', redacted: true },
    { line: '{"DATABASE_PASSWORD":"abc123"}', redacted: true },
    { line: 'config:tokenCount=7', redacted: false },
    { line: 'config:passwordPolicy=strict', redacted: false },
    { line: 'config:_authTokenCount=7', redacted: false },
  ])(
    'sanitizes credential assignment from a collected receipt: $line',
    async ({ line, redacted }) => {
      const subject = await fixture();
      try {
        await writeFile(join(subject.scratch, 'install-session.log'), `${line}\ncontinued\n`);
        await writeFile(join(subject.scratch, 'server-start.log'), 'safe neighboring log\n');
        await writeFile(join(subject.activation, 'result.log'), 'activation completed\n');
        const diagnostics = await collectInitialInstallFailureRecords(
          subject.root,
          subject.channelRoot,
        );
        const receipt = serializeInitialInstallFailureReceipt({
          testCase: 'real-stable-activation-mode',
          platform: 'linux',
          arch: 'x64',
          finishCode: 17,
          signal: null,
          stdoutDiagnostic: { status: 'incomplete' },
          stderrDiagnostic: { status: 'incomplete' },
          diagnostics,
        });
        const payload: unknown = JSON.parse(receipt.slice('REVO_INITIAL_INSTALL_FAILURE '.length));
        const expectedDiagnostic = redacted ? '[diagnostic omitted]' : `${line}\ncontinued`;

        expect(receipt.includes('abc123')).toBe(false);
        expect(receipt.includes(line)).toBe(!redacted);
        expect(receipt).not.toContain('receipt-credential-sentinel');
        expect(receipt).not.toContain('\n');
        expect(Buffer.byteLength(`${receipt}\n`, 'utf8')).toBeLessThanOrEqual(24 * 1024);
        expect(payload).toMatchObject({
          finishCode: 17,
          diagnostics: {
            status: 'complete',
            logs: {
              'install-session.log': {
                status: 'captured',
                diagnostic: expectedDiagnostic,
              },
              'server-start.log': {
                status: 'captured',
                diagnostic: 'safe neighboring log',
              },
              'activation-result.log': {
                status: 'captured',
                diagnostic: 'activation completed',
              },
            },
          },
        });
        expect(
          serializeInitialInstallFailureReceipt({
            testCase: 'real-stable-activation-mode',
            platform: 'linux',
            arch: 'x64',
            finishCode: 17,
            signal: null,
            stdoutDiagnostic: { status: 'incomplete' },
            stderrDiagnostic: { status: 'incomplete' },
            diagnostics,
          }),
        ).toBe(receipt);
      } finally {
        await rm(subject.root, { recursive: true, force: true });
      }
    },
  );

  it('omits one oversized file independently and retains safe diagnostics from the other logs', async () => {
    const subject = await fixture();
    try {
      await writeFile(join(subject.scratch, 'install-session.log'), 'x'.repeat(16 * 1024));
      await writeFile(join(subject.scratch, 'server-start.log'), 'application-bootstrap: ready\n');
      await writeFile(join(subject.activation, 'result.log'), 'activation status: unchanged\n');
      const diagnostics = await collectInitialInstallFailureRecords(
        subject.root,
        subject.channelRoot,
      );

      expect(diagnostics.logs['install-session.log']).toMatchObject({
        status: 'captured',
        diagnostic: '[diagnostic omitted]',
      });
      expect(diagnostics.logs['server-start.log']).toMatchObject({
        status: 'captured',
        diagnostic: 'application-bootstrap: ready',
      });
      expect(diagnostics.logs['activation-result.log']).toMatchObject({
        status: 'captured',
        diagnostic: 'activation status: unchanged',
      });
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it.each([
    { kind: 'file' as const, outcome: 'deferred' as const },
    { kind: 'directory' as const, outcome: 'deferred' as const },
    { kind: 'file' as const, outcome: 'rejected' as const },
    { kind: 'directory' as const, outcome: 'rejected' as const },
  ])(
    'tracks real $kind close lifecycle when the close operation is $outcome',
    async ({ kind, outcome }) => {
      const subject = await fixture();
      let fileHandle: FileHandle | undefined;
      let directoryHandle: Dir | undefined;
      let signalCloseEntered!: () => void;
      let releaseClose!: () => void;
      const closeEntered = new Promise<void>((resolve) => {
        signalCloseEntered = resolve;
      });
      const closeBarrier = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      let injected = false;
      let settledWhileClosePending = outcome !== 'deferred';
      let rootRetainedAfterRejectedClose = false;
      let diagnosticsContainIoError = false;
      let diagnosticsAreOmitted = false;
      let cleanupBeforeReleaseError: unknown;
      let cleanupAfterReleaseError: unknown;
      let diagnostics: InitialInstallDiagnostics | undefined;
      const finishClose = async (handle: { close: () => Promise<void> }) => {
        if (injected) {
          await handle.close();
          return;
        }
        injected = true;
        signalCloseEntered();
        if (outcome === 'rejected') {
          throw new Error('injected fs close rejection');
        }
        await closeBarrier;
        await handle.close();
      };
      const closeOperations: InitialDiagnosticCloseOperations =
        kind === 'file'
          ? {
              closeFile: (handle) => {
                fileHandle = handle;
                return finishClose(handle);
              },
            }
          : {
              closeDirectory: (handle) => {
                directoryHandle = handle;
                return finishClose(handle);
              },
            };
      let lease: InitialDiagnosticCollectionLease<InitialInstallDiagnostics> | undefined;
      try {
        await writeFile(join(subject.scratch, 'install-session.log'), 'bounded evidence\n');
        lease = startInitialDiagnosticCollection(subject.root, (signal, markCloseUncertain) =>
          collectInitialInstallFailureRecords(
            subject.root,
            subject.channelRoot,
            signal,
            undefined,
            markCloseUncertain,
            closeOperations,
          ),
        );
        await closeEntered;
        if (outcome === 'deferred') {
          try {
            await cleanupPortableToolchain(subject.root);
          } catch (error) {
            cleanupBeforeReleaseError = error;
          }
          let settled = false;
          void lease.promise.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          await Promise.resolve();
          settledWhileClosePending = settled;
          releaseClose();
          diagnostics = await lease.promise;
          try {
            await cleanupPortableToolchain(subject.root);
          } catch (error) {
            cleanupAfterReleaseError = error;
          }
        } else {
          diagnostics = await lease.promise;
          try {
            await cleanupPortableToolchain(subject.root);
          } catch (error) {
            cleanupBeforeReleaseError = error;
          }
          rootRetainedAfterRejectedClose = (await readdir(subject.root)).length > 0;
          diagnosticsContainIoError = Object.values(diagnostics.logs).some(
            (record) => record.status === 'io-error',
          );
          diagnosticsAreOmitted = Object.values(diagnostics.logs).every(
            (record) => record.diagnostic === '[diagnostic omitted]',
          );
        }
        expect(injected).toBe(true);
        expect(diagnostics?.status).toBe(outcome === 'deferred' ? 'complete' : 'incomplete');
        expect(settledWhileClosePending).toBe(outcome !== 'deferred');
        expect(cleanupBeforeReleaseError).toMatchObject({
          message: 'INITIAL_DIAGNOSTICS_NOT_QUIESCENT',
        });
        expect(cleanupAfterReleaseError).toBeUndefined();
        expect(rootRetainedAfterRejectedClose).toBe(outcome === 'rejected');
        expect(diagnosticsContainIoError).toBe(outcome === 'rejected');
        expect(diagnosticsAreOmitted).toBe(outcome === 'rejected');
      } finally {
        releaseClose();
        if (fileHandle) {
          await fileHandle.close().catch(() => undefined);
        }
        if (directoryHandle) {
          await directoryHandle.close().catch(() => undefined);
        }
        await rm(subject.root, { recursive: true, force: true });
      }
    },
  );

  it('settles collection and closes its reader before the real cleanup wrapper runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-initial-diagnostic-order-'));
    const logPath = join(root, 'diagnostic.log');
    await writeFile(logPath, 'bounded diagnostic evidence\n');
    const events: string[] = [];
    const originalFailure = new Error('original assertion failure');
    const finish = Promise.resolve(29);

    await expect(
      runWithPortableToolchainCleanup(
        root,
        async () => {
          const finishCode = await finishInitialInstallWithDiagnostics(
            'real-stable-activation-mode',
            root,
            { finish, outcome: () => ({ code: 29, signal: null }) },
            async (signal) => {
              events.push('collect-start');
              signal.throwIfAborted();
              const handle = await open(logPath, 'r');
              try {
                await handle.readFile('utf8');
              } finally {
                await handle.close();
                events.push('handle-close');
              }
              events.push('collect-settled');
              return {
                status: 'complete',
                reason: 'none',
                logs: {
                  'install-session.log': {
                    status: 'captured',
                    sizeBytes: 27,
                    diagnostic: 'diagnostics captured',
                  },
                  'server-start.log': {
                    status: 'missing',
                    sizeBytes: null,
                    diagnostic: '[diagnostic omitted]',
                  },
                  'activation-result.log': {
                    status: 'missing',
                    sizeBytes: null,
                    diagnostic: '[diagnostic omitted]',
                  },
                },
              };
            },
            (message) => {
              expect(message).toContain('"finishCode":29');
              events.push('receipt-reported');
            },
          );
          expect(finishCode).toBe(29);
          events.push('assertion');
          throw originalFailure;
        },
        async () => {
          events.push('cleanup');
          await cleanupPortableToolchain(root);
        },
      ),
    ).rejects.toBe(originalFailure);

    expect(events).toEqual([
      'collect-start',
      'handle-close',
      'collect-settled',
      'receipt-reported',
      'assertion',
      'cleanup',
    ]);
  });

  it('closes collector admission synchronously before cleanup can remove the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-initial-diagnostic-admission-'));
    let collectorStarted = false;

    const cleanup = cleanupPortableToolchain(root);
    expect(() =>
      startInitialDiagnosticCollection(root, async () => {
        collectorStarted = true;
        return undefined;
      }),
    ).toThrow('INITIAL_DIAGNOSTICS_ROOT_NOT_OPEN');
    await cleanup;

    expect(collectorStarted).toBe(false);
  });

  it.each(['canonical-first', 'alias-first'] as const)(
    'unifies multiple pending leases when %s canonicalizes first',
    async (resolutionOrder) => {
      const root = await mkdtemp(join(tmpdir(), 'revo-initial-diagnostic-alias-'));
      const alias = join(tmpdir(), `revo-initial-diagnostic-alias-link-${randomUUID()}`);
      await symlink(root, alias);
      let startedCount = 0;
      let notifyFirstStarted: (() => void) | undefined;
      const firstStarted = new Promise<void>((resolve) => {
        notifyFirstStarted = resolve;
      });
      let notifyBothStarted: (() => void) | undefined;
      const bothStarted = new Promise<void>((resolve) => {
        notifyBothStarted = resolve;
      });
      let releaseCollectors: (() => void) | undefined;
      const release = new Promise<void>((resolve) => {
        releaseCollectors = resolve;
      });
      let resolveRoot: ((canonicalRoot: string) => void) | undefined;
      const rootCanonicalization = new Promise<string>((resolve) => {
        resolveRoot = resolve;
      });
      let resolveAlias: ((canonicalRoot: string) => void) | undefined;
      const aliasCanonicalization = new Promise<string>((resolve) => {
        resolveAlias = resolve;
      });
      const collect = async () => {
        startedCount += 1;
        if (startedCount === 1) {
          notifyFirstStarted?.();
        }
        if (startedCount === 2) {
          notifyBothStarted?.();
        }
        await release;
      };
      try {
        const leases = [
          startInitialDiagnosticCollection(root, collect, () => rootCanonicalization),
          startInitialDiagnosticCollection(alias, collect, () => aliasCanonicalization),
        ];
        const canonicalRoot = await realpath(root);
        if (resolutionOrder === 'canonical-first') {
          resolveRoot?.(canonicalRoot);
          await firstStarted;
          resolveAlias?.(canonicalRoot);
        } else {
          resolveAlias?.(canonicalRoot);
          await firstStarted;
          resolveRoot?.(canonicalRoot);
        }
        await bothStarted;
        await expect(cleanupPortableToolchain(alias)).rejects.toThrow(
          'INITIAL_DIAGNOSTICS_NOT_QUIESCENT',
        );
        expect(() => startInitialDiagnosticCollection(root, collect)).toThrow(
          'INITIAL_DIAGNOSTICS_ROOT_NOT_OPEN',
        );
        releaseCollectors?.();
        await Promise.all(leases.map((lease) => lease.promise));
        await cleanupPortableToolchain(alias);
        await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(cleanupPortableToolchain(root)).resolves.toBeUndefined();
      } finally {
        releaseCollectors?.();
        await rm(alias, { force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('refuses cleanup through an unregistered symlink alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-initial-diagnostic-unknown-alias-'));
    const alias = join(tmpdir(), `revo-initial-diagnostic-unknown-link-${randomUUID()}`);
    await writeFile(join(root, 'sentinel'), 'still here');
    await symlink(root, alias);
    try {
      await expect(cleanupPortableToolchain(alias)).rejects.toThrow(
        'INITIAL_DIAGNOSTICS_UNKNOWN_ROOT_ALIAS',
      );
      expect(await readdir(root)).not.toHaveLength(0);
      await expect(cleanupPortableToolchain(root)).resolves.toBeUndefined();
    } finally {
      await rm(alias, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes the canonical fixture root when its parent is reached through a symlink', async () => {
    const base = await mkdtemp(join(tmpdir(), 'revo-initial-diagnostic-parent-alias-'));
    const canonicalParent = join(base, 'canonical-parent');
    const lexicalParent = join(base, 'lexical-parent');
    const canonicalRoot = join(canonicalParent, 'fixture');
    const lexicalRoot = join(lexicalParent, 'fixture');
    await mkdir(canonicalRoot, { recursive: true });
    await symlink(canonicalParent, lexicalParent, 'dir');
    await writeFile(join(canonicalRoot, 'sentinel'), 'still here');
    let notifyCollectorStarted: (() => void) | undefined;
    const collectorStarted = new Promise<void>((resolve) => {
      notifyCollectorStarted = resolve;
    });
    let releaseCollector: (() => void) | undefined;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseCollector = resolve;
    });
    try {
      const lease = startInitialDiagnosticCollection(lexicalRoot, async () => {
        notifyCollectorStarted?.();
        await waitForRelease;
      });
      await collectorStarted;
      await expect(cleanupPortableToolchain(lexicalRoot)).rejects.toThrow(
        'INITIAL_DIAGNOSTICS_NOT_QUIESCENT',
      );
      releaseCollector?.();
      await lease.promise;

      await cleanupPortableToolchain(lexicalRoot);
      await expect(readdir(canonicalRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(cleanupPortableToolchain(lexicalRoot)).resolves.toBeUndefined();
    } finally {
      releaseCollector?.();
      await rm(base, { recursive: true, force: true });
    }
  });

  it('keeps a timed-out collector lease active until late settlement, blocking cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-initial-diagnostic-timeout-'));
    const sentinelPath = join(root, 'keep-until-collector-settles');
    await writeFile(sentinelPath, 'still here');
    const originalFailure = new Error('original timeout scenario failure');
    let resolveCollector: ((value: InitialInstallDiagnostics) => void) | undefined;
    let notifyCollectorSettled: (() => void) | undefined;
    const collectorSettled = new Promise<void>((resolve) => {
      notifyCollectorSettled = resolve;
    });
    const report = vi.fn<(message: string) => void>();
    let capturedDiagnostics: InitialInstallDiagnostics | undefined;

    await expect(
      runWithPortableToolchainCleanup(root, async () => {
        const result = await finishInitialInstallWithDiagnostics(
          'real-stable-activation-mode',
          root,
          { finish: Promise.resolve(31), outcome: () => ({ code: 31, signal: null }) },
          (signal) => {
            signal.addEventListener('abort', () => undefined, { once: true });
            return new Promise<InitialInstallDiagnostics>((resolve) => {
              resolveCollector = resolve;
            }).finally(() => notifyCollectorSettled?.());
          },
          report,
          10,
          realpath,
          (diagnostics) => {
            capturedDiagnostics = diagnostics;
          },
        );
        expect(result).toBe(31);
        expect(report).toHaveBeenCalledTimes(1);
        expect(capturedDiagnostics).toMatchObject({
          status: 'incomplete',
          reason: 'collector-error',
        });
        throw originalFailure;
      }),
    ).rejects.toThrow('INITIAL_DIAGNOSTICS_NOT_QUIESCENT');

    await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('still here');
    resolveCollector?.({
      status: 'incomplete',
      reason: 'collector-error',
      logs: {
        'install-session.log': {
          status: 'incomplete',
          sizeBytes: null,
          diagnostic: '[diagnostic omitted]',
        },
        'server-start.log': {
          status: 'incomplete',
          sizeBytes: null,
          diagnostic: '[diagnostic omitted]',
        },
        'activation-result.log': {
          status: 'incomplete',
          sizeBytes: null,
          diagnostic: '[diagnostic omitted]',
        },
      },
    });
    await collectorSettled;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(cleanupPortableToolchain(root)).resolves.toBeUndefined();
    await expect(readFile(sentinelPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('starts the diagnostic deadline before asynchronous root canonicalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'revo-initial-diagnostic-realpath-'));
    const sentinelPath = join(root, 'keep-until-realpath-settles');
    await writeFile(sentinelPath, 'still here');
    let resolveRoot: ((path: string) => void) | undefined;
    const canonicalization = new Promise<string>((resolve) => {
      resolveRoot = resolve;
    });
    const collector = vi.fn<() => Promise<InitialInstallDiagnostics>>(async () => ({
      status: 'complete' as const,
      reason: 'none' as const,
      logs: {
        'install-session.log': {
          status: 'missing' as const,
          sizeBytes: null,
          diagnostic: '[diagnostic omitted]',
        },
        'server-start.log': {
          status: 'missing' as const,
          sizeBytes: null,
          diagnostic: '[diagnostic omitted]',
        },
        'activation-result.log': {
          status: 'missing' as const,
          sizeBytes: null,
          diagnostic: '[diagnostic omitted]',
        },
      },
    }));
    const report = vi.fn<(message: string) => void>();
    try {
      const finish = finishInitialInstallWithDiagnostics(
        'real-stable-activation-mode',
        root,
        { finish: Promise.resolve(37), outcome: () => ({ code: 37, signal: null }) },
        collector,
        report,
        10,
        () => canonicalization,
      );

      await expect(finish).resolves.toBe(37);
      expect(collector).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledTimes(1);
      await expect(cleanupPortableToolchain(root)).rejects.toThrow(
        'INITIAL_DIAGNOSTICS_NOT_QUIESCENT',
      );
      await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('still here');

      resolveRoot?.(root);
      await new Promise((resolve) => setImmediate(resolve));
      await cleanupPortableToolchain(root);
      await expect(readFile(sentinelPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      resolveRoot?.(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('captures before cleanup and preserves the original scenario failure if collection is incomplete', async () => {
    const subject = await fixture();
    const sequence: string[] = [];
    const scenarioFailure = new Error('original installer assertion');
    await rm(subject.root, { recursive: true, force: true });
    await expect(
      runWithPortableToolchainCleanup(
        subject.root,
        async () => {
          sequence.push('capture');
          const diagnostics = await collectInitialInstallFailureDiagnostics(
            subject.root,
            subject.channelRoot,
          );
          expect(diagnostics).toContain('status=incomplete');
          throw scenarioFailure;
        },
        async () => {
          sequence.push('cleanup');
        },
      ),
    ).rejects.toBe(scenarioFailure);
    expect(sequence).toEqual(['capture', 'cleanup']);
  });
});

it.each(['extra-key', 'oversized', 'symlink'] as const)(
  'real helper rejects an unsafe %s request without changing current state',
  async (kind) => {
    const subject = await activationScenario();
    try {
      await chmod(subject.channelRoot, 0o700);
      const helper = join(
        subject.first.packageDirectory,
        'dist',
        'bin',
        'revo-install-activate.js',
      );
      const compiledDirectory = join(subject.first.packageDirectory, 'dist');
      await cp(new URL('../dist/', import.meta.url), compiledDirectory, {
        recursive: true,
      });
      await writeFile(join(compiledDirectory, 'package.json'), '{"type":"module"}\n', {
        mode: 0o644,
      });
      await symlink(join(process.cwd(), 'node_modules'), join(compiledDirectory, 'node_modules'));
      expect(await realpath(resolvePath(dirname(helper), '../../../../..'))).toBe(
        await realpath(subject.channelRoot),
      );
      expect((await subject.activate()).status).toBe('activated');
      const before = validActivation(await readActivation(subject.channelRoot));
      const home = join(subject.root, 'helper-home');
      const directories = {
        HOME: join(home, 'home'),
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_DATA_HOME: join(home, 'data'),
        XDG_STATE_HOME: join(home, 'state'),
        XDG_CACHE_HOME: join(home, 'cache'),
        XDG_RUNTIME_DIR: join(home, 'runtime'),
      };
      await Promise.all(
        Object.values(directories).map((directory) =>
          mkdir(directory, { recursive: true, mode: 0o700 }),
        ),
      );
      const environment = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        ...directories,
        REVO_CHANNEL: 'stable',
        REVO_DATA_DIR: directories.XDG_DATA_HOME,
        REVO_INSTALL_ROOT: subject.channelRoot,
      };
      const requestRoot = join(
        subject.channelRoot,
        '.attempt.HelperTest123',
        'runtime',
        'scratch',
        '.activation-request-InvalidTest456',
      );
      await mkdir(requestRoot, { recursive: true, mode: 0o700 });
      const requestDirectories = [
        join(subject.channelRoot, '.attempt.HelperTest123'),
        join(subject.channelRoot, '.attempt.HelperTest123', 'runtime'),
        join(subject.channelRoot, '.attempt.HelperTest123', 'runtime', 'scratch'),
        requestRoot,
      ];
      const directoryModes = await Promise.all(
        requestDirectories.map(async (directory) => (await lstat(directory)).mode & 0o777),
      );
      expect((await lstat(subject.channelRoot)).mode & 0o777).toBe(0o700);
      expect(directoryModes).toEqual([0o700, 0o700, 0o700, 0o700]);
      const valid = {
        schemaVersion: 'revo-install-activate/v1',
        channelRoot: subject.channelRoot,
        packagePlan: subject.first.plan,
        nodeArchiveSha256: subject.first.nodeArchiveSha256,
        pnpmArchiveSha256: subject.first.pnpmArchiveSha256,
      };
      const requestPath = join(requestRoot, 'request.json');
      const runHelper = (path: string) =>
        new Promise<{
          readonly code: number | null;
          readonly signal: NodeJS.Signals | null;
          readonly stdout: string;
          readonly stderr: string;
          readonly timedOut: boolean;
          readonly outputExceeded: boolean;
          readonly spawnFailed: boolean;
        }>((resolve) => {
          const child = spawn(process.execPath, [helper, path], {
            env: environment,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          let timedOut = false;
          let outputExceeded = false;
          let spawnFailed = false;
          let terminationStarted = false;
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          const terminate = () => {
            if (terminationStarted) {
              return;
            }
            terminationStarted = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
          };
          const appendBounded = (current: string, chunk: string): string => {
            if (Buffer.byteLength(current) + Buffer.byteLength(chunk) > 8 * 1024) {
              outputExceeded = true;
              terminate();
              return current;
            }
            return current + chunk;
          };
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (chunk: string) => {
            stdout = appendBounded(stdout, chunk);
          });
          child.stderr.on('data', (chunk: string) => {
            stderr = appendBounded(stderr, chunk);
          });
          const deadline = setTimeout(() => {
            timedOut = true;
            terminate();
          }, 5_000);
          child.once('error', () => {
            spawnFailed = true;
          });
          child.once('close', (code, signal) => {
            clearTimeout(deadline);
            if (killTimer !== undefined) {
              clearTimeout(killTimer);
            }
            resolve({ code, signal, stdout, stderr, timedOut, outputExceeded, spawnFailed });
          });
        });

      const initialRequest = `${JSON.stringify(valid)}\n`;
      const targetPath = join(requestRoot, 'target.json');
      await writeFile(targetPath, initialRequest, { mode: 0o600 });
      await writeFile(requestPath, initialRequest, { mode: 0o600 });
      const positive = await runHelper(requestPath);
      expect(positive).toMatchObject({
        code: 0,
        signal: null,
        timedOut: false,
        outputExceeded: false,
        spawnFailed: false,
        stderr: '',
      });
      expect(JSON.parse(positive.stdout)).toMatchObject({
        schemaVersion: 'revo-install-activate/v1',
        status: 'unchanged',
        generationId: before.record.generationId,
      });
      expect(await readActivation(subject.channelRoot)).toEqual(before);

      if (kind === 'extra-key') {
        await writeFile(requestPath, `${JSON.stringify({ ...valid, extra: true })}\n`, {
          mode: 0o600,
        });
      } else if (kind === 'oversized') {
        const prefix = JSON.stringify(valid);
        await writeFile(requestPath, `${prefix}${' '.repeat(65_537 - Buffer.byteLength(prefix))}`, {
          mode: 0o600,
        });
      } else {
        await rm(requestPath);
        await symlink(targetPath, requestPath);
      }
      const requestStat = await lstat(requestPath);
      const requestContents = await readFile(requestPath, 'utf8');
      const targetContents = await readFile(targetPath, 'utf8');
      const extraKeyRequest = `${JSON.stringify({ ...valid, extra: true })}\n`;
      const fixtureValid =
        kind === 'extra-key'
          ? requestStat.isFile() &&
            (requestStat.mode & 0o777) === 0o600 &&
            requestContents === extraKeyRequest
          : kind === 'oversized'
            ? requestStat.isFile() &&
              (requestStat.mode & 0o777) === 0o600 &&
              requestStat.size === 65_537 &&
              requestContents.trimEnd() === JSON.stringify(valid)
            : requestStat.isSymbolicLink() && requestContents === initialRequest;
      expect(fixtureValid).toBe(true);
      expect(targetContents).toBe(initialRequest);
      const result = await runHelper(requestPath);
      expect(result).toMatchObject({
        code: 1,
        signal: null,
        stdout: '',
        stderr: 'activation helper failed\n',
        timedOut: false,
        outputExceeded: false,
        spawnFailed: false,
      });
      expect(await readActivation(subject.channelRoot)).toEqual(before);
      expect(await readFile(targetPath, 'utf8')).toBe(initialRequest);
    } finally {
      await subject.cleanup();
    }
  },
  60_000,
);

it.skipIf(process.env.REVO_RUN_REAL_INSTALLER_INTEGRATION !== '1')(
  'real activation refuses during startup and succeeds after the owner closes',
  async () => {
    let firstFixture: Awaited<ReturnType<typeof portableToolchain>> | undefined;
    let secondFixture: Awaited<ReturnType<typeof portableToolchain>> | undefined;
    let ownerScenario: ServerOwnerScenario | undefined;
    let started: Awaited<ReturnType<ServerOwnerScenario['openInstalledCandidate']>> | undefined;
    await runWithCleanupPreservingFailure(async () => {
      const first = (firstFixture = await portableToolchain('stable', undefined, false, true));
      const second = (secondFixture = await portableToolchain(
        'stable',
        '0.0.1',
        false,
        true,
        join(first.root, 'state'),
      ));
      const data = join(first.root, 'user-data');
      const scenario = (ownerScenario = await new ServerOwnerScenario().setup({ dataDir: data }));
      await mkdir(data, { recursive: true, mode: 0o700 });
      await writeFile(join(data, 'sentinel'), 'sentinel\n');
      const initialInstall = first.startInstaller({ REVO_DATA_DIR: data });
      expect(
        await finishInitialInstallWithDiagnostics(
          'real-activation-refuses-during-startup',
          first.root,
          initialInstall,
          (signal, markCloseUncertain) =>
            first.initialInstallFailureDiagnostics(signal, markCloseUncertain),
        ),
      ).toBe(0);
      await first.stopServer(data);
      const before = validActivation(await readActivation(join(first.root, 'state', 'stable')));
      const gate = join(first.root, 'state', 'stable', 'activation-barrier.gate');
      const marker = join(first.root, 'state', 'stable', 'activation-barrier.held');
      await writeFile(gate, 'hold\n', { mode: 0o600 });
      const prewarm = second.startInstaller({
        REVO_DATA_DIR: data,
        REVO_TEST_ACTIVATION_FAULT: 'cancel',
      });
      await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toContain('held'), {
        timeout: 120_000,
        interval: 25,
      });
      prewarm.child.kill('SIGTERM');
      expect(await prewarm.finish).not.toBe(0);
      await vi.waitFor(
        async () => expect((await new ServerOwnershipService().inspect(data)).kind).toBe('free'),
        { timeout: 120_000, interval: 25 },
      );
      expect(await readActivation(join(first.root, 'state', 'stable'))).toEqual(before);
      await rm(gate, { force: true });
      const channelRoot = join(first.root, 'state', 'stable');
      started = await scenario.openInstalledCandidate({
        channelRoot,
        generationId: before.record.generationId,
        version: before.record.release.version,
        executable: join(channelRoot, before.record.toolchain.nodeRef, 'bin', 'node'),
        coreEntry: join(channelRoot, before.record.packageRef, 'dist/bin/revo-core-host.js'),
      });
      expect(started.owner.status().phase).toBe('starting');
      expect(await second.startInstaller({ REVO_DATA_DIR: data }).finish).not.toBe(0);
      expect(await readActivation(join(first.root, 'state', 'stable'))).toEqual(before);
      started.releaseReady();
      await started.started;
      expect(started.owner.status().phase).toBe('running');
      expect(await second.startInstaller({ REVO_DATA_DIR: data }).finish).not.toBe(0);
      expect(await readActivation(join(first.root, 'state', 'stable'))).toEqual(before);
      await started.owner.close();
      expect(await second.startInstaller({ REVO_DATA_DIR: data }).finish).toBe(0);
      const after = validActivation(await readActivation(join(first.root, 'state', 'stable')));
      expect(after.record.generationId).not.toBe(before.record.generationId);
      expect(after.record.release.version).toBe('0.0.1');
      expect(await readFile(join(data, 'sentinel'), 'utf8')).toBe('sentinel\n');
    }, [
      async () => {
        started?.releaseReady();
        await ownerScenario?.cleanup();
      },
      async () => {
        if (secondFixture !== undefined) {
          await cleanupPortableToolchain(secondFixture.root);
        }
      },
      async () => {
        if (firstFixture !== undefined) {
          await cleanupPortableToolchain(firstFixture.root);
        }
      },
    ]);
  },
  360_000,
);

it.skipIf(process.env.REVO_RUN_REAL_INSTALLER_INTEGRATION !== '1')(
  'real activation cancellation before commit preserves current and retains the attempt',
  async () => {
    const first = await portableToolchain('stable', undefined, false, true);
    const second = await portableToolchain(
      'stable',
      '0.0.1',
      false,
      true,
      join(first.root, 'state'),
    );
    const gate = join(first.root, 'state', 'stable', 'activation-barrier.gate');
    const marker = join(first.root, 'state', 'stable', 'activation-barrier.held');
    const channelRoot = join(first.root, 'state', 'stable');
    let initialSucceeded = false;
    let cancellationPreserved = false;
    let retryStarted = false;
    let testOutcome: 'passed' | 'failed' | 'incomplete' = 'incomplete';
    let hasFailure = false;
    let primaryFailure: unknown;
    let cleanupAllowed = false;
    const cleanupOutcome: Record<string, string> = {
      beforeCleanupSnapshot: 'not-run',
      gate: 'not-run',
      secondFixture: 'not-run',
      firstFixture: 'not-run',
    };
    try {
      await prepareIntelInvocation('initial', [first.diagnosticContext]);
      const initial = first.startInstaller({}, 'initial');
      const initialCode = await initial.finish;
      initialSucceeded = initialCode === 0;
      expect(initialCode).toBe(0);
      await first.stopServer();
      await captureIntelSnapshot(
        'after-initial',
        [first.diagnosticContext],
        [
          {
            root: first.root,
            expectation: 'required',
            reason: 'initial installation completed and server startup was exercised',
          },
        ],
      );
      const before = validActivation(await readActivation(join(first.root, 'state', 'stable')));
      await writeFile(gate, 'hold\n', { mode: 0o600 });
      await prepareIntelInvocation('cancel-before-commit', [second.diagnosticContext]);
      const running = second.startInstaller(
        { REVO_TEST_ACTIVATION_FAULT: 'cancel' },
        'cancel-before-commit',
      );
      await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toContain('held'), {
        timeout: 120_000,
        interval: 25,
      });
      running.child.kill('SIGTERM');
      const cancellationCode = await running.finish;
      expect(cancellationCode).not.toBe(0);
      expect(await readActivation(join(first.root, 'state', 'stable'))).toEqual(before);
      await reportRecoveryAttempt({
        phase: 'after-cancellation',
        fixtureRoot: first.root,
        channelRoot,
        expectedCandidateVersion: second.plan.release.version,
        expectedGenerationId: before.record.generationId,
        installer: {
          finishCode: cancellationCode,
          outcome: running.outcome,
          stdoutTail: running.stdoutTail,
          stderrTail: running.stderrTail,
        },
      });
      expect(
        (await readdir(join(first.root, 'state', 'stable'))).some((name) =>
          name.startsWith('.attempt.'),
        ),
      ).toBe(true);
      cancellationPreserved = true;
      await captureIntelSnapshot(
        'after-cancellation',
        [first.diagnosticContext, second.diagnosticContext],
        [
          {
            root: first.root,
            expectation: 'required',
            reason: 'first fixture previously completed initial server startup',
          },
          {
            root: second.root,
            expectation: 'absent-permitted',
            reason: 'second fixture was cancelled before commit and before autostart',
          },
        ],
      );
      await rm(gate, { force: true });
      await prepareIntelInvocation('retry-after-cancel', [second.diagnosticContext]);
      retryStarted = true;
      const retry = second.startInstaller({}, 'retry-after-cancel');
      const retryCode = await retry.finish;
      await reportRecoveryAttempt({
        phase: 'after-retry',
        fixtureRoot: first.root,
        channelRoot,
        expectedCandidateVersion: second.plan.release.version,
        expectedGenerationId: before.record.generationId,
        installer: {
          finishCode: retryCode,
          outcome: retry.outcome,
          stdoutTail: retry.stdoutTail,
          stderrTail: retry.stderrTail,
        },
      });
      await captureIntelSnapshot(
        'after-retry',
        [first.diagnosticContext, second.diagnosticContext],
        [
          {
            root: first.root,
            expectation: 'required',
            reason: 'initial installation completed and server startup was exercised',
          },
          {
            root: second.root,
            expectation: 'required',
            reason: 'retry reached the server-start invocation',
          },
        ],
      );
      expect(retryCode).toBe(0);
      const after = validActivation(await readActivation(join(first.root, 'state', 'stable')));
      expect(after.record.generationId).not.toBe(before.record.generationId);
      testOutcome = 'passed';
    } catch (error) {
      testOutcome = 'failed';
      hasFailure = true;
      primaryFailure = error;
    } finally {
      if (intelCollectorsQuiescent()) {
        cleanupOutcome.beforeCleanupSnapshot = (await captureIntelSnapshot(
          'before-cleanup',
          [first.diagnosticContext, second.diagnosticContext],
          [
            {
              root: first.root,
              expectation: initialSucceeded ? 'required' : 'unknown',
              reason: initialSucceeded
                ? 'initial installation reached server startup'
                : 'initial phase was not confirmed',
            },
            {
              root: second.root,
              expectation: retryStarted
                ? 'required'
                : cancellationPreserved
                  ? 'absent-permitted'
                  : 'unknown',
              reason: retryStarted
                ? 'retry reached the server-start invocation'
                : cancellationPreserved
                  ? 'cancellation was confirmed before commit and retry did not start'
                  : 'second fixture startup phase is unknown',
            },
          ],
        ))
          ? 'captured'
          : 'incomplete';
        cleanupAllowed = intelCollectorsQuiescent();
        if (!cleanupAllowed) {
          cleanupOutcome.gate = 'skipped-collector-stop-unconfirmed';
          cleanupOutcome.secondFixture = 'skipped-collector-stop-unconfirmed';
          cleanupOutcome.firstFixture = 'skipped-collector-stop-unconfirmed';
          if (!hasFailure) {
            hasFailure = true;
            testOutcome = 'failed';
            primaryFailure = new Error('diagnostic collector stop was not confirmed');
          }
        }
      } else {
        cleanupOutcome.beforeCleanupSnapshot = 'skipped-collector-stop-unconfirmed';
        cleanupOutcome.gate = 'skipped-collector-stop-unconfirmed';
        cleanupOutcome.secondFixture = 'skipped-collector-stop-unconfirmed';
        cleanupOutcome.firstFixture = 'skipped-collector-stop-unconfirmed';
        if (!hasFailure) {
          hasFailure = true;
          testOutcome = 'failed';
          primaryFailure = new Error('diagnostic collector stop was not confirmed');
        }
      }
      if (cleanupAllowed) {
        try {
          await rm(gate, { force: true });
          cleanupOutcome.gate = 'complete';
        } catch {
          cleanupOutcome.gate = 'failed';
          if (!hasFailure) {
            hasFailure = true;
            testOutcome = 'failed';
            primaryFailure = new Error('activation diagnostic gate cleanup failed');
          }
        }
        try {
          await cleanupPortableToolchain(second.root);
          cleanupOutcome.secondFixture = 'complete';
        } catch {
          cleanupOutcome.secondFixture = 'failed';
          if (!hasFailure) {
            hasFailure = true;
            testOutcome = 'failed';
            primaryFailure = new Error('second fixture cleanup failed');
          }
        }
        try {
          await cleanupPortableToolchain(first.root);
          cleanupOutcome.firstFixture = 'complete';
        } catch {
          cleanupOutcome.firstFixture = 'failed';
          if (!hasFailure) {
            hasFailure = true;
            testOutcome = 'failed';
            primaryFailure = new Error('first fixture cleanup failed');
          }
        }
      }
      if (intelCollectorsQuiescent()) {
        try {
          await writeIntelDiagnosticSummary({ testOutcome, cleanupOutcome });
        } catch {
          if (!hasFailure) {
            hasFailure = true;
            testOutcome = 'failed';
            primaryFailure = new Error('activation diagnostic summary could not be written');
          }
          console.error('Intel diagnostic summary could not be written.');
        }
      } else {
        console.error('Intel diagnostic summary could not be written.');
      }
    }
    if (hasFailure) {
      throw primaryFailure;
    }
  },
  360_000,
);

it.skipIf(process.env.REVO_RUN_REAL_INSTALLER_INTEGRATION !== '1')(
  'real activation retains a committed generation when helper acknowledgement is lost',
  async () => {
    const first = await portableToolchain('stable', undefined, false, true);
    const second = await portableToolchain(
      'stable',
      '0.0.1',
      false,
      true,
      join(first.root, 'state'),
    );
    const channelRoot = join(first.root, 'state', 'stable');
    const postgresObserverPath = join(second.root, 'postgres-observer.log');
    try {
      expect(await first.startInstaller().finish).toBe(0);
      await recoveryRuntimeSnapshot({
        phase: 'before-first-stop',
        dataDir: first.dataDir,
        redactionRoots: [first.root, second.root],
        status: (await first.status()).kind,
      });
      await first.stopServer();
      await recoveryRuntimeSnapshot({
        phase: 'after-first-stop',
        dataDir: first.dataDir,
        redactionRoots: [first.root, second.root],
        status: (await first.status()).kind,
      });
      const before = validActivation(await readActivation(join(first.root, 'state', 'stable')));
      const running = second.startInstaller({ REVO_TEST_ACTIVATION_FAULT: 'unknown' });
      const faultCode = await running.finish;
      const faultAttempts = await second.attempts();
      const faultAttemptPath = faultAttempts[0];
      const faultAttemptName =
        faultAttempts.length === 1 && faultAttemptPath !== undefined
          ? basename(faultAttemptPath)
          : undefined;
      await reportRecoveryAttempt({
        phase: 'after-ack-loss-fault',
        fixtureRoot: first.root,
        channelRoot,
        ...(faultAttemptName === undefined ? {} : { attemptName: faultAttemptName }),
        expectedCandidateVersion: second.plan.release.version,
        expectedGenerationId: before.record.generationId,
        installer: {
          finishCode: faultCode,
          outcome: running.outcome,
          stdoutTail: running.stdoutTail,
          stderrTail: running.stderrTail,
        },
      });
      expect(faultCode).not.toBe(0);
      const committed = validActivation(await readActivation(join(first.root, 'state', 'stable')));
      expect(committed.record.generationId).not.toBe(before.record.generationId);
      expect(
        (await readdir(join(first.root, 'state', 'stable'))).some((name) =>
          name.startsWith('.attempt.'),
        ),
      ).toBe(true);
      await recoveryRuntimeSnapshot({
        phase: 'after-ack-loss-fault',
        dataDir: first.dataDir,
        redactionRoots: [first.root, second.root],
        status: (await first.status()).kind,
      });
      const attemptsBeforeRetry = new Set(await second.attempts());
      await writeFile(postgresObserverPath, '', { mode: 0o600 });
      const retryInstaller = second.startInstaller(
        { REVO_TEST_POSTGRES_DIAGNOSTIC: postgresObserverPath },
        'retry-after-ack-loss',
      );
      const retryCode = await retryInstaller.finish;
      const retryAttempts = (await second.attempts()).filter(
        (attempt) => !attemptsBeforeRetry.has(attempt),
      );
      const retryAttemptPath = retryAttempts[0];
      const retryAttemptName =
        retryAttempts.length === 1 && retryAttemptPath !== undefined
          ? basename(retryAttemptPath)
          : undefined;
      await reportRecoveryAttempt({
        phase: 'after-ack-loss-retry',
        fixtureRoot: first.root,
        channelRoot,
        ...(retryAttemptName === undefined ? {} : { attemptName: retryAttemptName }),
        postgresObserverPath,
        expectedCandidateVersion: second.plan.release.version,
        expectedGenerationId: committed.record.generationId,
        installer: {
          finishCode: retryCode,
          outcome: retryInstaller.outcome,
          stdoutTail: retryInstaller.stdoutTail,
          stderrTail: retryInstaller.stderrTail,
        },
      });
      await recoveryRuntimeSnapshot({
        phase: 'after-ack-loss-retry',
        dataDir: first.dataDir,
        redactionRoots: [first.root, second.root],
        status: (await first.status()).kind,
      });
      expect(retryCode).toBe(0);
      const retry = validActivation(await readActivation(join(first.root, 'state', 'stable')));
      expect(retry.record.generationId).toBe(committed.record.generationId);
    } finally {
      await cleanupPortableToolchain(second.root);
      await cleanupPortableToolchain(first.root);
    }
  },
  360_000,
);

describe('generated POSIX toolchain installer', () => {
  it.each(['stable', 'alpha'] as const)(
    'embeds isolated %s Node and pnpm handoff',
    async (channel) => {
      const script = await toolchainInstaller(channel);
      const data = await installerData(channel);
      expect(data.channel).toBe(channel);
      expect(script).toContain('revo_lock=$revo_channel_root/.install.lock');
      expect(script).toContain('REVO_INSTALL_MODE=pnpm');
      expect(script).toContain('REVO_INSTALL_SCRATCH=$revo_scratch');
      expect(await syntax(script)).toBe(0);
    },
  );
  it('retains the v2 Node-only lock and payload contract', async () => {
    const script = await nodeInstaller();
    expect(script).toContain('revo_parent=$revo_root/$revo_version');
    expect(script).toContain('revo_lock=$revo_parent/.$revo_target.install.lock');
    expect((await nodeData()).channel).toBeUndefined();
  });
  it('keeps literal bootstrap and payload delimiters singular', async () => {
    const script = await toolchainInstaller();
    expect(script.match(/^REVO_NODE_BOOTSTRAP_DATA$/gmu)).toHaveLength(1);
    expect(script.match(/^REVO_NODE_BOOTSTRAP_PAYLOAD$/gmu)).toHaveLength(1);
    expect(script).toContain("revo_channel='stable'");
  });
  it('publishes Node from a private attempt before the canonical re-exec', async () => {
    const script = await toolchainInstaller();
    expect(script).toContain('revo_attempt=');
    expect(script).toContain('REVO_INSTALL_MODE=node');
    expect(script).toContain('$revo_final/bin/node');
    expect(script).not.toContain('mv "$revo_final/bootstrap.json"');
  });
  it.each(['stable', 'alpha'] as const)(
    'runs generated %s bytes fresh and reuses Node',
    async (channel) => {
      const subject = await portableToolchain(channel);
      try {
        expect(await subject.runInstaller()).toBe(0);
        expect(await subject.runInstaller()).toBe(0);
        const identity = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
        const target = join(
          subject.root,
          'state',
          channel,
          'node',
          process.versions.node,
          identity,
        );
        const pnpm = join(
          subject.root,
          'state',
          channel,
          'pnpm',
          process.versions.node,
          identity,
          '12.5.1',
        );
        const pnpmLauncher = await readFile(join(pnpm, 'pnpm'), 'utf8');
        expect(pnpmLauncher).toContain('exec node ');
        expect(pnpmLauncher).not.toContain('REVO_PRIVATE_NODE_ROOT/bin/node');
        expect(await readFile(join(target, 'install-receipt.json'), 'utf8')).toContain(identity);
        expect(await readFile(join(pnpm, 'install-receipt.json'), 'utf8')).toContain('12.5.1');
        expect(await readFile(subject.calls, 'utf8')).toHaveLength(1);
        await writeFile(join(target, 'install-receipt.json'), '{}\n');
        expect(await subject.runInstaller()).not.toBe(0);
      } finally {
        await cleanupPortableToolchain(subject.root);
      }
    },
    30000,
  );
  it('drains an interrupted generated download and preserves the signal status', async () => {
    const subject = await portableToolchain();
    const hold = join(subject.root, 'hold');
    try {
      await writeFile(hold, 'hold');
      const running = subject.startInstaller({ REVO_CURL_HOLD: hold });
      await vi.waitFor(
        async () => {
          expect(await readFile(subject.calls, 'utf8')).toHaveLength(1);
        },
        { timeout: 5000, interval: 10 },
      );
      running.child.kill('SIGINT');
      expect(await running.finish).toBe(130);
    } finally {
      await cleanupPortableToolchain(subject.root);
    }
  }, 15000);
});

describe('private Node selection for pnpm probes', () => {
  const supportedTarget =
    (process.platform === 'linux' || process.platform === 'darwin') &&
    (process.arch === 'arm64' || process.arch === 'x64');

  it.skipIf(!supportedTarget)(
    'uses the private Node from PATH for fresh probes and reuse',
    async () => {
      const subject = await privateNodeProbeFixture();
      try {
        const first = await subject.provision();
        expect(first.reused).toBe(false);
        expect(first.executablePath).toBe(join(subject.target, 'pnpm'));
        expect(subject.request).toHaveBeenCalledTimes(1);
        const [freshProbe] = await subject.invocations();
        if (freshProbe === undefined) {
          throw new Error('private Node probe did not leave evidence');
        }
        expect(freshProbe?.[0]).toBe(subject.nodeExecutable);
        expect(freshProbe[1]).toMatch(new RegExp(`^${subject.scratch}/\\.pnpm-probe-`));
        expect(freshProbe[2]).toBe(join(freshProbe[1] ?? '', 'home'));
        expect(freshProbe?.[3]).toBe(freshProbe?.[1]);
        expect(freshProbe?.[4]?.split(':')[0]).toBe(subject.privateNodeBin);
        expect(freshProbe?.[5]).toBe('');
        expect(freshProbe?.[6]).toBe('3');
        expect(freshProbe?.[7]).toMatch(/\/launcher\.mjs$/u);
        expect(freshProbe?.[8]).toBe('--pm-on-fail=ignore');
        expect(freshProbe?.[9]).toBe('--version');
        expect(await readdir(subject.scratch)).toEqual([]);

        const executableBeforeReuse = await readFile(first.executablePath);
        const receiptBeforeReuse = await readFile(join(subject.target, 'install-receipt.json'));
        const reused = await subject.provision();
        expect(reused.reused).toBe(true);
        expect(subject.request).toHaveBeenCalledTimes(1);
        const probes = await subject.invocations();
        expect(probes).toHaveLength(2);
        expect(probes[1]?.[0]).toBe(subject.nodeExecutable);
        expect(probes[1]?.[1]).not.toBe(probes[0]?.[1]);
        expect(probes[1]?.[4]?.split(':')[0]).toBe(subject.privateNodeBin);
        expect(probes[1]?.[5]).toBe('');
        expect(await readdir(subject.scratch)).toEqual([]);
        expect(await readFile(first.executablePath)).toEqual(executableBeforeReuse);
        expect(await readFile(join(subject.target, 'install-receipt.json'))).toEqual(
          receiptBeforeReuse,
        );
      } finally {
        await subject.cleanup();
      }
    },
  );

  it.skipIf(!supportedTarget)(
    'fails closed when the selected private Node exits nonzero',
    async () => {
      const subject = await privateNodeProbeFixture(47);
      try {
        await expect(subject.provision()).rejects.toThrow(/pnpm probe: version command failed/u);
        const [failedProbe] = await subject.invocations();
        expect(failedProbe?.[0]).toBe(subject.nodeExecutable);
        expect(failedProbe?.[4]?.split(':')[0]).toBe(subject.privateNodeBin);
        expect(failedProbe?.[5]).toBe('');
        await expect(lstat(subject.target)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(subject.scratch)).toEqual([]);
      } finally {
        await subject.cleanup();
      }
    },
  );
});
