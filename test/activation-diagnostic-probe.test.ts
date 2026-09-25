import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { managedActivationScenario } from './support/installation/managed-activation-scenario.js';

const probePath = fileURLToPath(
  new URL('./support/installation/activation-diagnostic-probe.mjs', import.meta.url),
);
const realDriverPath = fileURLToPath(
  new URL('./support/installation/activation-diagnostic-real-child.mjs', import.meta.url),
);
const compiledDist = fileURLToPath(new URL('../dist/', import.meta.url));
const MAX_CHILD_CAPTURE_BYTES = 8 * 1024;
const CHILD_TIMEOUT_MS = 10_000;

const helperSource = `
import assert from 'node:assert/strict';
import { ManagedActivationService } from '../installation/managed-activation.service.js';
import { ConfigurationResolver } from '../configuration/configuration-resolver.js';
import { ServerOwnershipService } from '../processes/server-ownership.service.js';

const managed = new ManagedActivationService();
const configuration = new ConfigurationResolver();
const ownership = new ServerOwnershipService();
globalThis.callCounts = { managed: 0, admission: 0, perform: 0, configuration: 0, ownership: 0 };
const managedArguments = [{ sentinel: 'argument-secret' }, { count: 2 }];
const configurationArgument = { configSentinel: true };
const ownershipArgument = '/private/fixture/data';
globalThis.expectedManagedResult = {
  status: process.env.REVO_PROBE_UNKNOWN_STATUS === '1' ? 'surprise' : 'activated',
  generationId: process.env.REVO_PROBE_UNKNOWN_STATUS === '1' ? 'not-a-generation' : 'a'.repeat(64),
  secret: 'token=must-not-be-logged',
};
globalThis.expectedAdmissionResult = { status: 'busy', secret: 'password=admission-secret' };
globalThis.expectedPerformResult = {
  outcome: {
    status: process.env.REVO_PROBE_UNKNOWN_STATUS === '1' ? 'surprise' : 'activated',
  },
  secret: 'token=perform-secret',
};
globalThis.expectedConfigurationResult = { channel: 'stable', secret: 'cookie=must-not-be-logged' };
globalThis.expectedOwnershipResult = {
  kind: process.env.REVO_PROBE_UNKNOWN_STATUS === '1' ? 'surprise' : 'held',
  secret: 'authorization=must-not-be-logged',
};
globalThis.expectedError = new Error('password=super-secret');

if (process.env.REVO_PROBE_THROW === 'managed') {
  try {
    await managed.activate(...managedArguments);
    throw new Error('expected managed activation rejection');
  } catch (error) {
    assert.strictEqual(error, globalThis.expectedError);
  }
} else {
  const returned = await managed.activate(...managedArguments);
  assert.strictEqual(returned, globalThis.expectedManagedResult);
  assert.strictEqual(globalThis.managedCall.receiver, managed);
  assert.strictEqual(globalThis.managedCall.args.length, managedArguments.length);
  assert.strictEqual(globalThis.managedCall.args[0], managedArguments[0]);
  assert.strictEqual(globalThis.managedCall.args[1], managedArguments[1]);
}

if (process.env.REVO_PROBE_THROW === 'admission') {
  try {
    managed.admissionOutcome('busy', { secret: 'argument-secret' });
    throw new Error('expected admission rejection');
  } catch (error) {
    assert.strictEqual(error, globalThis.expectedError);
  }
} else {
  const admissionArguments = ['busy', { secret: 'argument-secret' }];
  const admissionResult = managed.admissionOutcome(...admissionArguments);
  assert.strictEqual(admissionResult, globalThis.expectedAdmissionResult);
  assert.equal(typeof admissionResult?.then, 'undefined');
  assert.strictEqual(globalThis.admissionCall.receiver, managed);
  assert.strictEqual(globalThis.admissionCall.args[0], admissionArguments[0]);
  assert.strictEqual(globalThis.admissionCall.args[1], admissionArguments[1]);
}

if (process.env.REVO_PROBE_THROW === 'perform') {
  try {
    await managed.performActivation({ secret: 'argument-secret' });
    throw new Error('expected perform rejection');
  } catch (error) {
    assert.strictEqual(error, globalThis.expectedError);
  }
} else {
  const performArguments = [{ secret: 'argument-secret' }];
  const performResult = await managed.performActivation(...performArguments);
  assert.strictEqual(performResult, globalThis.expectedPerformResult);
  assert.strictEqual(globalThis.performCall.receiver, managed);
  assert.strictEqual(globalThis.performCall.args[0], performArguments[0]);
}

const resolved = await configuration.resolve(configurationArgument);
assert.strictEqual(resolved, globalThis.expectedConfigurationResult);
assert.strictEqual(globalThis.configurationCall.receiver, configuration);
assert.strictEqual(globalThis.configurationCall.args[0], configurationArgument);
const acquired = await ownership.acquire(ownershipArgument);
assert.strictEqual(acquired, globalThis.expectedOwnershipResult);
assert.strictEqual(globalThis.ownershipCall.receiver, ownership);
assert.strictEqual(globalThis.ownershipCall.args[0], ownershipArgument);
if (process.env.REVO_PROBE_OVERFLOW === '1') {
  for (let index = 0; index < 12; index += 1) await managed.activate(...managedArguments);
}
assert.deepEqual(globalThis.callCounts, {
  managed: process.env.REVO_PROBE_OVERFLOW === '1' ? 13 : 1,
  admission: 1,
  perform: 1,
  configuration: 1,
  ownership: 1,
});
if (process.env.REVO_PROBE_VERIFY_SETUP_FAILURE === '1') {
  for (const [prototype, method, descriptor] of globalThis.originalDescriptors) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, method), descriptor);
  }
}
process.stdout.write('PROBE_ASSERTIONS=PASS\\n');
`;

async function probeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'revo-activation-probe-'));
  const bin = join(root, 'dist', 'bin');
  const helper = join(bin, 'revo-install-activate.js');
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(join(root, 'dist', 'installation'), { recursive: true }),
    mkdir(join(root, 'dist', 'configuration'), { recursive: true }),
    mkdir(join(root, 'dist', 'processes'), { recursive: true }),
  ]);
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(helper, helperSource);
  await writeFile(
    join(root, 'dist', 'installation', 'managed-activation.service.js'),
    `export class ManagedActivationService { async activate(...args) { globalThis.callCounts.managed += 1; globalThis.managedCall = { receiver: this, args }; if (process.env.REVO_PROBE_THROW === 'managed') throw globalThis.expectedError; return globalThis.expectedManagedResult; } admissionOutcome(...args) { globalThis.callCounts.admission += 1; globalThis.admissionCall = { receiver: this, args }; if (process.env.REVO_PROBE_THROW === 'admission') throw globalThis.expectedError; return globalThis.expectedAdmissionResult; } async performActivation(...args) { globalThis.callCounts.perform += 1; globalThis.performCall = { receiver: this, args }; if (process.env.REVO_PROBE_THROW === 'perform') throw globalThis.expectedError; return globalThis.expectedPerformResult; } }\n`,
  );
  await writeFile(
    join(root, 'dist', 'configuration', 'configuration-resolver.js'),
    `export class ConfigurationResolver { async resolve(...args) { globalThis.callCounts.configuration += 1; globalThis.configurationCall = { receiver: this, args }; return globalThis.expectedConfigurationResult; } }\n`,
  );
  await writeFile(
    join(root, 'dist', 'processes', 'server-ownership.service.js'),
    `export class ServerOwnershipService { async acquire(...args) { globalThis.callCounts.ownership += 1; globalThis.ownershipCall = { receiver: this, args }; return globalThis.expectedOwnershipResult; } }\n`,
  );
  return { root, helper };
}

async function setupFailurePreload(root: string, kind: 'descriptor' | 'installation') {
  const modules = {
    managed: pathToFileURL(join(root, 'dist', 'installation', 'managed-activation.service.js'))
      .href,
    configuration: pathToFileURL(join(root, 'dist', 'configuration', 'configuration-resolver.js'))
      .href,
    ownership: pathToFileURL(join(root, 'dist', 'processes', 'server-ownership.service.js')).href,
  };
  const path = join(root, `setup-${kind}.mjs`);
  await writeFile(
    path,
    `const [managed, configuration, ownership] = await Promise.all([import(${JSON.stringify(modules.managed)}), import(${JSON.stringify(modules.configuration)}), import(${JSON.stringify(modules.ownership)})]);
const targets = [[managed.ManagedActivationService.prototype, 'activate'], [managed.ManagedActivationService.prototype, 'admissionOutcome'], [managed.ManagedActivationService.prototype, 'performActivation'], [configuration.ConfigurationResolver.prototype, 'resolve'], [ownership.ServerOwnershipService.prototype, 'acquire']];
${kind === 'descriptor' ? `const [prototype, method] = targets.at(-1); const descriptor = Object.getOwnPropertyDescriptor(prototype, method); Object.defineProperty(prototype, method, { ...descriptor, writable: false, configurable: false });` : `const original = Object.defineProperty; let failed = false; Object.defineProperty = function (target, key, descriptor) { if (!failed && target === targets.at(-1)[0] && key === targets.at(-1)[1]) { failed = true; throw new Error('test-only observer install failure'); } return Reflect.apply(original, Object, [target, key, descriptor]); };`}
globalThis.originalDescriptors = targets.map(([prototype, method]) => [prototype, method, Object.getOwnPropertyDescriptor(prototype, method)]);
`,
    { mode: 0o600 },
  );
  return path;
}

async function runRealActivation(
  mode: string,
  options: {
    readonly observe?: boolean;
    readonly preloads?: readonly string[];
    readonly failOutput?: boolean;
  } = {},
) {
  const scenario = await managedActivationScenario();
  try {
    const bin = join(scenario.root, 'dist', 'bin');
    const installation = join(scenario.root, 'dist', 'installation');
    const configuration = join(scenario.root, 'dist', 'configuration');
    const processes = join(scenario.root, 'dist', 'processes');
    await Promise.all([
      mkdir(bin, { recursive: true }),
      mkdir(installation, { recursive: true }),
      mkdir(configuration, { recursive: true }),
      mkdir(processes, { recursive: true }),
    ]);
    await writeFile(join(scenario.root, 'package.json'), '{"type":"module"}\n', {
      mode: 0o600,
    });
    const helper = join(bin, 'activation-diagnostic-real-child.mjs');
    await writeFile(helper, await readFile(realDriverPath, 'utf8'), { mode: 0o600 });

    const exportShim = async (relativePath: string, exportName: string, compiledPath: string) =>
      writeFile(
        join(scenario.root, 'dist', relativePath),
        `export { ${exportName} } from ${JSON.stringify(pathToFileURL(compiledPath).href)};\n`,
        { mode: 0o600 },
      );
    await Promise.all([
      exportShim(
        'installation/managed-activation.service.js',
        'ManagedActivationService',
        join(compiledDist, 'installation', 'managed-activation.service.js'),
      ),
      exportShim(
        'installation/activation-store.js',
        'readActivation',
        join(compiledDist, 'installation', 'activation-store.js'),
      ),
      exportShim(
        'configuration/configuration-resolver.js',
        'ConfigurationResolver',
        join(compiledDist, 'configuration', 'configuration-resolver.js'),
      ),
      exportShim(
        'processes/server-ownership.service.js',
        'ServerOwnershipService',
        join(compiledDist, 'processes', 'server-ownership.service.js'),
      ),
    ]);

    const inputPath = join(scenario.root, 'activation-diagnostic-input.json');
    await writeFile(
      inputPath,
      JSON.stringify({
        mode,
        channelRoot: scenario.channelRoot,
        candidate: scenario.first,
        configuration: scenario.configuration(),
      }),
      { mode: 0o600 },
    );
    const preloads = [...(options.preloads ?? [])];
    if (options.failOutput) {
      preloads.unshift(await outputFailurePreload(scenario.root));
    }
    const args = [
      ...preloads.flatMap((preload) => ['--import', preload]),
      ...(options.observe ? ['--import', probePath] : []),
      helper,
      inputPath,
    ];
    const child = await runNode(args);
    const summary = child.code === 0 ? JSON.parse(child.stdout) : undefined;
    return { child, summary };
  } finally {
    await scenario.release();
  }
}

async function outputFailurePreload(root: string) {
  const path = join(root, 'stderr-failure.mjs');
  await writeFile(
    path,
    `const original = process.stderr.write.bind(process.stderr); let writes = 0; let failed = false; process.stderr.write = function (...args) { writes += 1; if (!failed && writes === 4) { failed = true; throw new Error('test-only stderr failure'); } return original(...args); };\n`,
    { mode: 0o600 },
  );
  return path;
}

function runNode(
  args: readonly string[],
  variables: Readonly<Record<string, string>> = {},
  timeoutMs = CHILD_TIMEOUT_MS,
) {
  return new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly outputExceeded: boolean;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...variables },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let killTimer: NodeJS.Timeout | undefined;
    let spawnError: Error | undefined;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 250);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const capture = (target: Buffer[], chunk: Buffer) => {
      const available = MAX_CHILD_CAPTURE_BYTES - capturedBytes;
      if (available > 0) {
        const retained = chunk.subarray(0, available);
        target.push(retained);
        capturedBytes += retained.length;
      }
      if (chunk.length > available && !outputExceeded) {
        outputExceeded = true;
        stop();
      }
    };
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.once('error', (error) => {
      spawnError = error;
      stop();
    });
    child.once('close', (code) => {
      clearTimeout(deadline);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (spawnError) {
        reject(spawnError);
        return;
      }
      resolve({
        code,
        signal: child.signalCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        outputExceeded,
      });
    });
  });
}

function runProbe(
  helper: string,
  variables: Readonly<Record<string, string>> = {},
  preloads: readonly string[] = [],
) {
  return runNode(
    [...preloads.flatMap((preload) => ['--import', preload]), '--import', probePath, helper],
    variables,
  );
}

describe('activation diagnostic probe', () => {
  it('reports only allowlisted boundary facts and preserves receiver, arguments, and result identity', async () => {
    const subject = await probeFixture();
    try {
      const result = await runProbe(subject.helper);
      expect(result.code).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.outputExceeded).toBe(false);
      expect(result.stdout).toBe('PROBE_ASSERTIONS=PASS\n');
      expect(result.stderr).toContain('phase=probe event=ready');
      expect(result.stderr).toContain('phase=managed event=enter');
      expect(result.stderr).toContain(
        'phase=managed event=return status=activated generationValid=true',
      );
      expect(result.stderr).toContain('phase=configuration event=return');
      expect(result.stderr).toContain('phase=server-ownership event=return status=held');
      expect(result.stderr).not.toContain('argument-secret');
      expect(result.stderr).not.toContain('must-not-be-logged');
      expect(result.stderr).not.toContain('admission-secret');
      expect(result.stderr).not.toContain('perform-secret');
      expect(result.stderr).not.toContain('cookie=');
      expect(result.stderr).not.toContain('authorization=');
      expect(
        result.stderr
          .split('\n')
          .filter(Boolean)
          .every((line) => line.startsWith('REVO_ACTIVATION_DIAG v=1 ')),
      ).toBe(true);
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['managed', 'managed'],
    ['admission', 'activation-admission'],
    ['perform', 'perform-activation'],
  ])(
    'rethrows the original %s error object without disclosing its message',
    async (phase, event) => {
      const subject = await probeFixture();
      try {
        const result = await runProbe(subject.helper, { REVO_PROBE_THROW: phase });
        expect(result.code).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(result.outputExceeded).toBe(false);
        expect(result.stdout).toBe('PROBE_ASSERTIONS=PASS\n');
        expect(result.stderr).toContain(`phase=${event} event=throw`);
        expect(result.stderr).not.toContain('super-secret');
        expect(result.stderr).not.toContain('password=');
        expect(result.stderr).not.toContain('argument-secret');
      } finally {
        await rm(subject.root, { recursive: true, force: true });
      }
    },
  );

  it('maps unknown statuses to fixed values and bounds record count and bytes', async () => {
    const subject = await probeFixture();
    try {
      const result = await runProbe(subject.helper, {
        REVO_PROBE_UNKNOWN_STATUS: '1',
        REVO_PROBE_OVERFLOW: '1',
      });
      const lines = result.stderr.split('\n').filter(Boolean);
      expect(result.code).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.outputExceeded).toBe(false);
      expect(result.stderr).toContain(
        'phase=managed event=return status=other generationValid=false',
      );
      expect(result.stderr).toContain('phase=perform-activation event=return status=other');
      expect(result.stderr).toContain('event=truncated');
      expect(lines.length).toBeLessThanOrEqual(16);
      expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(2 * 1024);
      expect(lines.every((line) => line.startsWith('REVO_ACTIVATION_DIAG v=1 '))).toBe(true);
      expect(result.stderr).not.toContain('surprise');
      expect(result.stderr).not.toContain('must-not-be-logged');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it.each(['descriptor', 'installation'] as const)(
    'fails closed on %s setup failure without leaving partial observers installed',
    async (kind) => {
      const subject = await probeFixture();
      try {
        const preload = await setupFailurePreload(subject.root, kind);
        const result = await runProbe(subject.helper, { REVO_PROBE_VERIFY_SETUP_FAILURE: '1' }, [
          preload,
        ]);
        expect(result.code).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(result.outputExceeded).toBe(false);
        expect(result.stdout).toBe('PROBE_ASSERTIONS=PASS\n');
        expect(result.stderr).toContain('phase=probe event=incomplete');
        expect(result.stderr).not.toContain('phase=probe event=ready');
        expect(result.stderr).not.toContain('phase=managed event=');
      } finally {
        await rm(subject.root, { recursive: true, force: true });
      }
    },
  );

  it('reports actual channel mismatch without entering admission or activation', async () => {
    const baseline = await runRealActivation('channel-mismatch');
    const observed = await runRealActivation('channel-mismatch', { observe: true });
    expect(baseline.child.code).toBe(0);
    expect(observed.child.code).toBe(0);
    expect(observed.child.timedOut).toBe(false);
    expect(observed.child.outputExceeded).toBe(false);
    expect(observed.summary).toEqual(baseline.summary);
    expect(observed.summary).toMatchObject({ result: 'unavailable', current: 'absent' });
    expect(observed.summary.counters).toMatchObject({ admission: 0, serverLock: 0 });
    expect(observed.child.stderr).toContain('phase=configuration event=return');
    expect(observed.child.stderr).toContain('phase=managed event=return status=unavailable');
    expect(observed.child.stderr).not.toContain('phase=activation-admission event=');
    expect(observed.child.stderr).not.toContain('phase=perform-activation event=');
    expect(observed.child.stderr).toContain('phase=probe event=ready');
    expect(observed.child.stderr).not.toMatch(/event=(?:incomplete|truncated)/u);
  });

  it.each([
    ['busy', 'busy'],
    ['cancelled', 'cancelled'],
    ['unavailable', 'unavailable'],
  ])('observes real managed admission result %s exactly once', async (status, expected) => {
    const mode = `admission-${status}`;
    const baseline = await runRealActivation(mode);
    const observed = await runRealActivation(mode, { observe: true });
    expect(baseline.child.code).toBe(0);
    expect(observed.child.code).toBe(0);
    expect(observed.summary).toEqual(baseline.summary);
    expect(observed.summary).toMatchObject({ result: expected, current: 'absent' });
    expect(observed.summary.counters).toMatchObject({
      admission: 1,
      activationRelease: 0,
      serverLock: 0,
    });
    expect(observed.child.stderr).toContain(
      `phase=activation-admission event=enter status=${expected}`,
    );
    expect(observed.child.stderr).not.toContain('phase=perform-activation event=');
    expect(observed.child.stderr).not.toContain('phase=server-ownership event=');
  });

  it('observes invalid compiled candidate before server acquisition and releases ownership once', async () => {
    const baseline = await runRealActivation('invalid-candidate');
    const observed = await runRealActivation('invalid-candidate', { observe: true });
    expect(baseline.child.code).toBe(0);
    expect(observed.child.code).toBe(0);
    expect(observed.summary).toEqual(baseline.summary);
    expect(observed.summary).toMatchObject({ result: 'unavailable', current: 'absent' });
    expect(observed.summary.counters).toMatchObject({
      admission: 1,
      activationRelease: 1,
      serverLock: 0,
    });
    expect(observed.child.stderr).toContain('phase=perform-activation event=enter');
    expect(observed.child.stderr).toContain(
      'phase=perform-activation event=return status=unavailable',
    );
    expect(observed.child.stderr).not.toContain('phase=server-ownership event=');
  });

  it('observes successful compiled activation and both ownership releases', async () => {
    const baseline = await runRealActivation('success');
    const observed = await runRealActivation('success', { observe: true });
    expect(baseline.child.code).toBe(0);
    expect(observed.child.code).toBe(0);
    expect(observed.summary).toEqual(baseline.summary);
    expect(observed.summary).toMatchObject({
      result: 'activated',
      current: 'valid',
      currentGenerationValid: true,
    });
    expect(observed.summary.counters).toMatchObject({
      admission: 1,
      activationRelease: 1,
      serverLock: 1,
      serverUnlock: 1,
    });
    expect(observed.child.stderr).toContain(
      'phase=perform-activation event=return status=activated',
    );
    expect(observed.child.stderr).toContain('phase=server-ownership event=return status=held');
    expect(observed.child.stderr).toContain('phase=managed event=return status=activated');
  });

  it('preserves configuration exception identity and performs no later activation work', async () => {
    const baseline = await runRealActivation('configuration-error');
    const observed = await runRealActivation('configuration-error', { observe: true });
    expect(baseline.child.code).toBe(0);
    expect(observed.child.code).toBe(0);
    expect(observed.summary).toEqual(baseline.summary);
    expect(observed.summary).toMatchObject({ result: 'threw', configurationErrorIdentity: true });
    expect(observed.summary.counters).toMatchObject({ admission: 0, serverLock: 0 });
    expect(observed.child.stderr).toContain('phase=configuration event=throw');
    expect(observed.child.stderr).toContain('phase=managed event=throw');
    expect(observed.child.stderr).not.toContain('phase=activation-admission event=');
    expect(observed.child.stderr).not.toContain('phase=perform-activation event=');
    expect(observed.child.stderr).not.toContain('test-only configuration failure');
  });

  it('reports unknown outcome after attempting both releases when cleanup fails', async () => {
    const baseline = await runRealActivation('cleanup-failure');
    const observed = await runRealActivation('cleanup-failure', { observe: true });
    expect(baseline.child.code).toBe(0);
    expect(observed.child.code).toBe(0);
    expect(observed.summary).toEqual(baseline.summary);
    expect(observed.summary).toMatchObject({ result: 'outcome-unknown', current: 'valid' });
    expect(observed.summary.counters).toMatchObject({
      admission: 1,
      activationRelease: 1,
      serverLock: 1,
      serverUnlock: 1,
    });
    expect(observed.child.stderr).toContain(
      'phase=perform-activation event=return status=activated',
    );
    expect(observed.child.stderr).toContain(
      'phase=managed event=return status=outcome-unknown generationValid=false',
    );
  });

  it('keeps activation result while marking a dropped diagnostic trace incomplete', async () => {
    const baseline = await runRealActivation('success');
    const observed = await runRealActivation('success', { observe: true, failOutput: true });
    expect(baseline.child.code).toBe(0);
    expect(observed.child.code).toBe(0);
    expect(observed.summary).toEqual(baseline.summary);
    expect(observed.child.stderr).toContain('phase=probe event=ready');
    expect(observed.child.stderr).toContain('phase=probe event=incomplete');
    expect(observed.child.stderr).not.toContain('phase=configuration event=return');
    expect(observed.child.stderr).not.toContain('phase=managed event=return');
    expect(observed.child.stderr).not.toContain('phase=perform-activation event=');
  });

  it('bounds captured child output and terminates children on overflow or deadline', async () => {
    const overflow = await runNode([
      '--input-type=module',
      '-e',
      "process.stdout.write('x'.repeat(65536)); setInterval(() => {}, 1000);",
    ]);
    expect(overflow.outputExceeded).toBe(true);
    expect(overflow.timedOut).toBe(false);
    expect(overflow.signal).not.toBeNull();
    expect(
      Buffer.byteLength(overflow.stdout) + Buffer.byteLength(overflow.stderr),
    ).toBeLessThanOrEqual(MAX_CHILD_CAPTURE_BYTES);

    const deadline = await runNode(
      ['--input-type=module', '-e', 'setInterval(() => {}, 1000);'],
      {},
      50,
    );
    expect(deadline.timedOut).toBe(true);
    expect(deadline.signal).not.toBeNull();
  });

  it('matches only the exact private Node, helper, cwd, and fixture request invocation', async () => {
    const matcherUrl = new URL(
      './support/installation/activation-helper-invocation.mjs',
      import.meta.url,
    ).href;
    const root = '/fixture/state';
    const privateNodeRoot = `${root}/node/v26/linux-x64`;
    const cwd = `${root}/package/0.0.0/linux-x64`;
    const command = `${privateNodeRoot}/bin/node`;
    const helper = `${cwd}/dist/bin/revo-install-activate.js`;
    const request = `${root}/.attempt.Abc123/runtime/scratch/.activation-request-Def456/request.json`;
    const diagnosticProbeUrl = 'file:///diagnostic-probe.mjs';
    const script = `
      import { activationHelperSpawnArguments as spawnArguments, isExactActivationHelperInvocation as matches } from ${JSON.stringify(matcherUrl)};
      const env = { REVO_PRIVATE_NODE_ROOT: ${JSON.stringify(privateNodeRoot)}, REVO_INSTALL_ROOT: ${JSON.stringify(root)} };
      const options = { cwd: ${JSON.stringify(cwd)} };
      const args = [${JSON.stringify(helper)}, ${JSON.stringify(request)}];
      const result = {
        exact: matches(${JSON.stringify(command)}, args, options, env),
        disabled: spawnArguments(${JSON.stringify(command)}, args, options, env, false, ${JSON.stringify(diagnosticProbeUrl)}),
        enabled: spawnArguments(${JSON.stringify(command)}, args, options, env, true, ${JSON.stringify(diagnosticProbeUrl)}),
        wrongExecutable: matches('/usr/bin/node', args, options, env),
        wrongWorkingDirectory: matches(${JSON.stringify(command)}, args, { cwd: '/tmp/other' }, env),
        extraArgument: matches(${JSON.stringify(command)}, [...args, 'extra'], options, env),
        wrongHelper: matches(${JSON.stringify(command)}, ['/tmp/other.js', args[1]], options, env),
        outsideRequest: matches(${JSON.stringify(command)}, [args[0], '/tmp/request.json'], options, env),
        wrongExecutableArguments: spawnArguments('/usr/bin/node', args, options, env, true, ${JSON.stringify(diagnosticProbeUrl)}),
      };
      process.stdout.write(JSON.stringify(result));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      exact: true,
      disabled: [helper, request],
      enabled: ['--import', diagnosticProbeUrl, helper, request],
      wrongExecutable: false,
      wrongWorkingDirectory: false,
      extraArgument: false,
      wrongHelper: false,
      outsideRequest: false,
      wrongExecutableArguments: [helper, request],
    });
  });
});
