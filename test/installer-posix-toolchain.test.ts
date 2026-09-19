import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { readActivation, type ActivationReadResult } from '../src/installation/activation-store.js';
import { ServerOwnershipService } from '../src/processes/server-ownership.service.js';
import { parseLifecycleDocument } from '../src/server-logs/document.js';
import { ServerLifecycleStore, serverLifecyclePath } from '../src/server-logs/store.service.js';
import {
  captureIntelSnapshot as captureIntelSnapshotUnsafe,
  cleanupPortableToolchain,
  intelCollectorsQuiescent,
  installerData,
  nodeData,
  nodeInstaller,
  portableToolchain,
  prepareIntelInvocation,
  recordIntelCollectorIssue,
  resolveToolchainFixtureHome,
  runWithPortableToolchainCleanup,
  toolchainInstaller,
  writeIntelDiagnosticSummary,
} from './support/installation/installer-toolchain-scenario.js';
import { ServerOwnerScenario } from './support/server/server-owner-scenario.js';

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

it.each(['stable', 'alpha'] as const)(
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
    await runWithPortableToolchainCleanup(
      subject.root,
      async () => {
        expect(subject.plan.release.version).toMatch(/^0\.0\./u);
        const installation = subject.startInstaller();
        const installationCode = await installation.finish;
        installerOutcome = formatInstallerOutcome(installation.outcome());
        installerStderrTail = installation.stderrTail();
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

it.each(['extra-key', 'oversized', 'symlink'] as const)(
  'real helper rejects an unsafe %s request without changing current state',
  async (kind) => {
    const subject = await portableToolchain('stable', undefined, false, true);
    const requestRoot = await mkdtemp(join(subject.root, 'request-'));
    try {
      expect(await subject.startInstaller().finish).toBe(0);
      const before = validActivation(await readActivation(join(subject.root, 'state', 'stable')));
      const helper = join(
        subject.root,
        'state',
        'stable',
        before.record.packageRef,
        'dist/bin/revo-install-activate.js',
      );
      const valid = {
        schemaVersion: 'revo-install-activate/v1',
        channelRoot: join(subject.root, 'state'),
        packagePlan: subject.plan,
        nodeArchiveSha256: subject.nodeArchiveSha256,
        pnpmArchiveSha256: subject.pnpmArchiveSha256,
      };
      const requestPath = join(requestRoot, 'request.json');
      if (kind === 'extra-key') {
        await writeFile(requestPath, `${JSON.stringify({ ...valid, extra: true })}\n`, {
          mode: 0o600,
        });
      } else if (kind === 'oversized') {
        await writeFile(requestPath, `${'x'.repeat(64 * 1024 + 1)}\n`, { mode: 0o600 });
      } else {
        const targetPath = join(requestRoot, 'target.json');
        await writeFile(targetPath, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
        await symlink(targetPath, requestPath);
      }
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [helper, requestPath], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => (stderr += chunk));
        child.once('close', (code) => resolve({ code, stderr }));
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toBe('activation helper failed\n');
      expect(await readActivation(join(subject.root, 'state', 'stable'))).toEqual(before);
    } finally {
      await cleanupPortableToolchain(subject.root);
    }
  },
  180_000,
);

it('real activation refuses during startup and succeeds after the owner closes', async () => {
  const first = await portableToolchain('stable', undefined, false, true);
  const second = await portableToolchain('stable', '0.0.1', false, true, join(first.root, 'state'));
  const data = join(first.root, 'user-data');
  const scenario = await new ServerOwnerScenario().setup({ dataDir: data });
  let started: Awaited<ReturnType<ServerOwnerScenario['openInstalledCandidate']>> | undefined;
  try {
    await mkdir(data, { recursive: true, mode: 0o700 });
    await writeFile(join(data, 'sentinel'), 'sentinel\n');
    expect(await first.startInstaller({ REVO_DATA_DIR: data }).finish).toBe(0);
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
  } finally {
    started?.releaseReady();
    await scenario.cleanup();
    await cleanupPortableToolchain(second.root);
    await cleanupPortableToolchain(first.root);
  }
}, 360_000);

it('real activation cancellation before commit preserves current and retains the attempt', async () => {
  const first = await portableToolchain('stable', undefined, false, true);
  const second = await portableToolchain('stable', '0.0.1', false, true, join(first.root, 'state'));
  const gate = join(first.root, 'state', 'stable', 'activation-barrier.gate');
  const marker = join(first.root, 'state', 'stable', 'activation-barrier.held');
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
}, 360_000);

it('real activation retains a committed generation when helper acknowledgement is lost', async () => {
  const first = await portableToolchain('stable', undefined, false, true);
  const second = await portableToolchain('stable', '0.0.1', false, true, join(first.root, 'state'));
  try {
    expect(await first.startInstaller().finish).toBe(0);
    await first.stopServer();
    const before = validActivation(await readActivation(join(first.root, 'state', 'stable')));
    const running = second.startInstaller({ REVO_TEST_ACTIVATION_FAULT: 'unknown' });
    expect(await running.finish).not.toBe(0);
    const committed = validActivation(await readActivation(join(first.root, 'state', 'stable')));
    expect(committed.record.generationId).not.toBe(before.record.generationId);
    expect(
      (await readdir(join(first.root, 'state', 'stable'))).some((name) =>
        name.startsWith('.attempt.'),
      ),
    ).toBe(true);
    expect(await second.startInstaller().finish).toBe(0);
    const retry = validActivation(await readActivation(join(first.root, 'state', 'stable')));
    expect(retry.record.generationId).toBe(committed.record.generationId);
  } finally {
    await cleanupPortableToolchain(second.root);
    await cleanupPortableToolchain(first.root);
  }
}, 360_000);

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
          '12.4.1',
        );
        expect(await readFile(join(target, 'install-receipt.json'), 'utf8')).toContain(identity);
        expect(await readFile(join(pnpm, 'install-receipt.json'), 'utf8')).toContain('12.4.1');
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
