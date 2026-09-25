import { spawn } from 'node:child_process';
import {
  chmod,
  cp,
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
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { runInNewContext } from 'node:vm';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { readActivation, type ActivationReadResult } from '../src/installation/activation-store.js';
import { ServerOwnershipService } from '../src/processes/server-ownership.service.js';
import { parseLifecycleDocument } from '../src/server-logs/document.js';
import { ServerLifecycleStore, serverLifecyclePath } from '../src/server-logs/store.service.js';
import { activationScenario } from './support/installation/activation-scenario.js';
import {
  captureIntelSnapshot as captureIntelSnapshotUnsafe,
  cleanupPortableToolchain,
  collectInstallAttemptDiagnostics,
  collectInitialInstallFailureDiagnostics,
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

describe('initial installation failure diagnostics', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'revo-initial-diagnostics-'));
    const channelRoot = join(root, 'state', 'stable');
    const scratch = join(channelRoot, '.attempt.Abc123', 'runtime', 'scratch');
    const activation = join(scratch, '.activation-request-Def456');
    await mkdir(activation, { recursive: true, mode: 0o700 });
    return { root, channelRoot, scratch, activation };
  }

  it('reads only the three fixed logs and redacts secrets, paths, ANSI, and workflow commands', async () => {
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
      expect(output).toContain('activation helper failed');
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

  it('bounds each file tail and the total diagnostic output', async () => {
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
      expect(output).toContain(`sizeBytes=${Buffer.byteLength(large, 'utf8')} truncated=true`);
      expect(output).toContain('final-evidence-line');
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
      expect(missingOutput).toContain('attempts=missing');

      const logsMissing = await fixture();
      try {
        const output = await collectInitialInstallFailureDiagnostics(
          logsMissing.root,
          logsMissing.channelRoot,
        );
        expect(output).toContain('attempts=1 activationRequest=captured');
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
        ).toContain('attempts=ambiguous');
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
        expect(output).toContain('activationRequest=ambiguous');
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
      expect(parentOutput).toContain('attempts=1');
      expect(parentOutput).toContain('install-session.log status=unsafe');
      expect(parentOutput).not.toContain('outside-secret');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it('keeps prefixed multibyte lines whole within the aggregate output cap', async () => {
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
      expect(output).toContain('status=output-truncated');
      expect(output).toContain(' | é');
      expect(lines.every((line) => line.startsWith('POSIX_INSTALL_DIAGNOSTIC '))).toBe(true);
      expect(output).not.toContain('\uFFFD');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it('strips controls before secret redaction so escape sequences cannot split credentials', async () => {
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

      expect(output).toContain('password=[redacted]');
      expect(output).not.toContain('escape-secret');
      expect(output).not.toContain('\u001b');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
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
          expect(diagnostics).toContain('status=diagnostics-incomplete');
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
    const first = await portableToolchain('stable', undefined, false, true);
    const second = await portableToolchain(
      'stable',
      '0.0.1',
      false,
      true,
      join(first.root, 'state'),
    );
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
