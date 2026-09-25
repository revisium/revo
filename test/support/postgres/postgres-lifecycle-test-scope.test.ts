import { describe, expect, it, vi } from 'vitest';

import { PostgresLifecycleScenario } from './postgres-lifecycle-scenario.js';
import { PostgresLifecycleTestScope } from './postgres-lifecycle-test-scope.js';

describe('PostgresLifecycleTestScope', () => {
  it('uses a fresh scenario after each confirmed cleanup', async () => {
    const createScenario = vi.fn<() => ControlledScenario>(
      () => new ControlledScenario(async () => undefined),
    );
    const scope = new PostgresLifecycleTestScope(createScenario);

    const first = scope.begin();
    await scope.cleanup();
    const second = scope.begin();

    expect(second).not.toBe(first);
    expect(createScenario).toHaveBeenCalledTimes(2);
    await scope.cleanup();
  });

  it('does not begin another scenario while cleanup is pending', async () => {
    let releaseCleanup!: () => void;
    const close = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );
    const createScenario = vi.fn<() => ControlledScenario>(() => new ControlledScenario(close));
    const scope = new PostgresLifecycleTestScope(createScenario);
    scope.begin();

    const cleanup = scope.cleanup();

    expect(() => scope.begin()).toThrow(/cleanup is still pending/u);
    expect(createScenario).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    releaseCleanup();
    await cleanup;
  });

  it('retains a failed scenario and refuses to create its successor', async () => {
    const failure = new Error('cleanup failed');
    const createScenario = vi.fn<() => ControlledScenario>(
      () => new ControlledScenario(() => Promise.reject(failure)),
    );
    const scope = new PostgresLifecycleTestScope(createScenario);

    scope.begin();
    await expect(scope.cleanup()).rejects.toBe(failure);

    expect(() => scope.begin()).toThrow(/previous.*cleanup failed/iu);
    expect(createScenario).toHaveBeenCalledTimes(1);
  });

  it('allows a new scenario only after an explicit cleanup retry succeeds', async () => {
    const failure = new Error('transient cleanup failure');
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const createScenario = vi.fn<() => ControlledScenario>(() => new ControlledScenario(close));
    const scope = new PostgresLifecycleTestScope(createScenario);
    const first = scope.begin();

    await expect(scope.cleanup()).rejects.toBe(failure);
    await scope.cleanup();
    const second = scope.begin();

    expect(second).not.toBe(first);
    expect(close).toHaveBeenCalledTimes(2);
    expect(createScenario).toHaveBeenCalledTimes(2);
    await scope.cleanup();
  });

  it('coalesces concurrent cleanup requests for the active scenario', async () => {
    let releaseCleanup!: () => void;
    const close = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );
    const scope = new PostgresLifecycleTestScope(() => new ControlledScenario(close));
    scope.begin();

    const first = scope.cleanup();
    const second = scope.cleanup();

    expect(second).toBe(first);
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    releaseCleanup();
    await Promise.all([first, second]);
  });
});

class ControlledScenario extends PostgresLifecycleScenario {
  constructor(private readonly close: () => Promise<void>) {
    super();
  }

  override cleanup() {
    return this.close();
  }
}
