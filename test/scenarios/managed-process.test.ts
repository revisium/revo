import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ManagedProcessService } from '../../src/processes/managed-process.service.js';
import { ManagedProcessScenario } from '../support/process/managed-process-scenario.js';

describe('managed child process', () => {
  let scenario: ManagedProcessScenario;

  beforeEach(async () => {
    scenario = await new ManagedProcessScenario().setup();
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it('passes exact argv, environment, and cwd without a shell', async () => {
    const metacharacters = 'value with spaces;$(echo not-a-shell)*';
    const handle = await scenario.start(
      scenario.request(['environment', metacharacters], {
        env: { ONLY_THIS: 'present' },
      }),
    );

    const report = await scenario.environment(handle);
    expect(report).toEqual({
      cwd: expect.any(String),
      env: { ONLY_THIS: 'present' },
      argv: [metacharacters],
    });
    expect(report.cwd).toContain('revo-managed-process-');
  });

  it('reports normal and nonzero completion without treating spawn as readiness', async () => {
    const normal = await scenario.start(scenario.request(['exit', '0']));
    const failed = await scenario.startThroughNest(scenario.request(['exit', '7']));

    await expect(scenario.completion(normal)).resolves.toEqual({ exitCode: 0, signal: null });
    await expect(scenario.completion(failed)).resolves.toEqual({ exitCode: 7, signal: null });
  });

  it('reports that cancellation was not requested when the child exits normally', async () => {
    const cancellation = new AbortController();
    const handle = await scenario.start(
      scenario.request(['exit', '0'], {
        cancellation: { graceMs: 100, killWaitMs: 100, signal: cancellation.signal },
      }),
    );

    await expect(handle.cancellationResult).resolves.toEqual({ kind: 'not-requested' });
  });

  it('reports an absolute missing executable without exposing argv or env', async () => {
    const request = scenario.request(['secret-argument'], {
      env: { SECRET_TOKEN: 'secret-environment' },
      executable: '/definitely/missing/revo-child',
    });

    const error = await scenario.start(request).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'revo.process.spawn' });
    expect(String(error)).not.toContain('secret-argument');
    expect(String(error)).not.toContain('secret-environment');
  });

  it.each([
    ['argv', { args: ['secret-argument\0suffix'] }],
    ['environment', { env: { SECRET_TOKEN: 'secret-environment\0suffix' } }],
  ])('normalizes a synchronous spawn failure from invalid %s', async (_case, overrides) => {
    const error = await scenario
      .start(scenario.request([], overrides))
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'revo.process.spawn' });
    expect(String(error)).not.toContain('secret-');
  });

  it('rejects invalid requests before spawn', async () => {
    await expect(
      scenario.start(scenario.request(['exit', '0'], { executable: 'relative-node' })),
    ).rejects.toMatchObject({ code: 'revo.process.invalid' });
  });

  it('does not spawn when already aborted', async () => {
    const cancellation = new AbortController();
    cancellation.abort();

    await expect(
      scenario.start(
        scenario.request(['marker', scenario.markerPath()], {
          cancellation: { graceMs: 20, killWaitMs: 1_000, signal: cancellation.signal },
        }),
      ),
    ).rejects.toMatchObject({ code: 'revo.process.cancelled' });
    expect(await scenario.markerExists()).toBe(false);
  });

  it('cancels while the child is still spawning and waits for cleanup', async () => {
    const cancellation = new AbortController();
    const starting = scenario.start(
      scenario.request(['marker', scenario.markerPath()], {
        cancellation: { graceMs: 20, killWaitMs: 1_000, signal: cancellation.signal },
      }),
    );

    cancellation.abort();

    await expect(starting).rejects.toMatchObject({ code: 'revo.process.cancelled' });
    expect(await scenario.markerExists()).toBe(false);
  });

  it('stops a cooperative child with TERM after an IPC barrier', async () => {
    const handle = await scenario.start(scenario.request(['term'], { ipc: true }));
    await scenario.begin(handle);

    await new ManagedProcessService().stop(handle, { graceMs: 500, killWaitMs: 500 });

    await expect(handle.completion).resolves.toEqual({ exitCode: 0, signal: null });
  });

  it('escalates a TERM-resistant child to KILL and waits for exit', async () => {
    const handle = await scenario.start(scenario.request(['resist'], { ipc: true }));
    await scenario.begin(handle);
    const termReceived = scenario.waitForMessage(handle);

    await new ManagedProcessService().stop(handle, { graceMs: 100, killWaitMs: 1_000 });

    await expect(termReceived).resolves.toEqual({ state: 'term-received' });
    await expect(handle.completion).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' });
  });

  it('reports a bounded stop timeout without claiming the child exited', async () => {
    const handle = await scenario.startWithoutExitObservation(
      scenario.request(['resist'], { ipc: true }),
    );
    await scenario.begin(handle);

    await expect(
      new ManagedProcessService().stop(handle, { graceMs: 500, killWaitMs: 500 }),
    ).rejects.toMatchObject({ code: 'revo.process.stop-timeout' });
    await expect(handle.completion).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' });
  });

  it('coalesces concurrent and repeated stop operations', async () => {
    const service = new ManagedProcessService();
    const handle = await scenario.start(scenario.request(['term'], { ipc: true }));
    await scenario.begin(handle);

    await expect(
      Promise.all([
        service.stop(handle, { graceMs: 500, killWaitMs: 500 }),
        service.stop(handle, { graceMs: 500, killWaitMs: 500 }),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    await expect(service.stop(handle, { graceMs: 1, killWaitMs: 1 })).resolves.toBeUndefined();
  });

  it('rejects timer values that Node would clamp before signalling the child', async () => {
    const service = new ManagedProcessService();
    const handle = await scenario.start(scenario.request(['term'], { ipc: true }));
    await scenario.begin(handle);

    await expect(
      service.stop(handle, { graceMs: 2_147_483_648, killWaitMs: 1_000 }),
    ).rejects.toMatchObject({ code: 'revo.process.invalid' });

    await service.stop(handle, { graceMs: 500, killWaitMs: 500 });
  });

  it('cancels a running owned child without touching an unrelated child or parent listeners', async () => {
    const cancellation = new AbortController();
    const unrelated = await scenario.startUnrelated();
    const parentListeners = process.listenerCount('SIGTERM');
    const handle = await scenario.start(
      scenario.request(['resist'], {
        cancellation: { graceMs: 20, killWaitMs: 1_000, signal: cancellation.signal },
        ipc: true,
      }),
    );
    await scenario.begin(handle);

    cancellation.abort();
    await handle.completion;

    await expect(handle.cancellationResult).resolves.toEqual({ kind: 'stopped' });
    expect(scenario.isRunning(unrelated)).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(parentListeners);
  });

  it('observes a redacted cancellation cleanup failure without rejecting in the background', async () => {
    const cancellation = new AbortController();
    const handle = await scenario.startWithoutExitObservation(
      scenario.request(['resist'], {
        cancellation: { graceMs: 500, killWaitMs: 500, signal: cancellation.signal },
        ipc: true,
      }),
    );
    await scenario.begin(handle);

    cancellation.abort();

    await expect(handle.cancellationResult).resolves.toMatchObject({
      kind: 'failed',
      error: { code: 'revo.process.stop-timeout' },
    });
    await expect(handle.completion).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' });
  });
});
