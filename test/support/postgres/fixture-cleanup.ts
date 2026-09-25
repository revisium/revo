// Observation bound only: does not change process signals, grace, or kill-wait.
const CLEANUP_OBSERVATION_MS = 7_000;

export class FixtureCleanupTimeoutError extends Error {
  constructor() {
    super('Fixture cleanup remains unconfirmed');
    this.name = 'FixtureCleanupTimeoutError';
  }
}

interface FixtureOwner {
  close(): Promise<void>;
  ownershipReleased(): Promise<void>;
}

export async function closeFixtureOwner(
  owner: FixtureOwner,
  expectedCloseFailure: (error: unknown) => boolean = () => false,
  timeoutMs = CLEANUP_OBSERVATION_MS,
): Promise<void> {
  // Observe release independently: close can reject while finalization continues.
  const [closed, released] = await Promise.allSettled([
    observeFixtureCleanup(
      Promise.resolve().then(() => owner.close()),
      timeoutMs,
    ),
    observeFixtureCleanup(
      Promise.resolve().then(() => owner.ownershipReleased()),
      timeoutMs,
    ),
  ]);
  const failures: unknown[] = [];
  if (
    closed.status === 'rejected' &&
    (released.status === 'rejected' || !expectedCloseFailure(closed.reason))
  ) {
    failures.push(closed.reason);
  }
  if (released.status === 'rejected') {
    failures.push(released.reason);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      released.status === 'fulfilled'
        ? 'Fixture owner close failed after confirmed release'
        : 'Fixture owner release remains unconfirmed',
    );
  }
}

export async function observeFixtureCleanup<T>(
  operation: Promise<T>,
  timeoutMs = CLEANUP_OBSERVATION_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FixtureCleanupTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function cleanupRegistered<T>(
  entries: T[],
  close: (entry: T) => Promise<void>,
): Promise<void> {
  const snapshot = [...entries];
  const results = await Promise.allSettled(
    snapshot.map(async (entry) => {
      await close(entry);
      const index = entries.indexOf(entry);
      if (index !== -1) {
        entries.splice(index, 1);
      }
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Fixture cleanup failed; unresolved resources retained');
  }
}
