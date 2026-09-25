import { rm } from 'node:fs/promises';

import { PublishedControlError } from '../../../src/processes/published-control.service.js';
import { observeFixtureCleanup } from './fixture-cleanup.js';

const OWNER_CLEANUP_OBSERVATION_MS = 7_000;

class OwnerObservationTimeoutError extends Error {
  constructor() {
    super('Provision fixture owner observation timed out');
    this.name = 'OwnerObservationTimeoutError';
  }
}

class OwnerStateFailure extends AggregateError {
  constructor(errors: readonly unknown[], message: string) {
    super(errors, message);
    this.name = 'OwnerStateFailure';
  }
}

type OperationSettlement =
  | { readonly kind: 'pending' }
  | { readonly kind: 'fulfilled' }
  | { readonly kind: 'rejected'; readonly error: unknown };

interface TrackedOperation {
  readonly promise: Promise<void>;
  readonly settlementPromise: Promise<Exclude<OperationSettlement, { kind: 'pending' }>>;
  settlement: OperationSettlement;
}

type OperationObservation =
  | { readonly kind: 'unconfirmed'; readonly error: unknown }
  | {
      readonly kind: 'settled';
      readonly settlement: Exclude<OperationSettlement, { kind: 'pending' }>;
    };

function trackOperation(
  promise: Promise<void>,
  onRejected?: (error: unknown) => void,
): TrackedOperation {
  let resolveSettlement!: (settlement: Exclude<OperationSettlement, { kind: 'pending' }>) => void;
  const settlementPromise = new Promise<Exclude<OperationSettlement, { kind: 'pending' }>>(
    (resolve) => {
      resolveSettlement = resolve;
    },
  );
  const tracked: TrackedOperation = {
    promise,
    settlement: { kind: 'pending' },
    settlementPromise,
  };
  void promise.then(
    () => {
      const settlement = { kind: 'fulfilled' as const };
      tracked.settlement = settlement;
      resolveSettlement(settlement);
    },
    (error: unknown) => {
      const settlement = { kind: 'rejected' as const, error };
      tracked.settlement = settlement;
      resolveSettlement(settlement);
      onRejected?.(error);
    },
  );
  return tracked;
}

async function observeOperation(operation: TrackedOperation): Promise<OperationObservation> {
  try {
    return {
      kind: 'settled',
      settlement: await observeFixtureCleanup(operation.settlementPromise),
    };
  } catch (error) {
    if (operation.settlement.kind === 'pending') {
      return { kind: 'unconfirmed', error };
    }
    return { kind: 'settled', settlement: operation.settlement };
  }
}

export interface ProvisionFixtureOwner {
  close(): Promise<void>;
  ownershipReleased(): Promise<void>;
}

interface OwnerRecord {
  readonly owner: ProvisionFixtureOwner;
  readonly closeOperations: TrackedOperation[];
  readonly closeFailures: Set<unknown>;
  expectedCloseFailure: (error: unknown) => boolean;
  releaseOperation?: TrackedOperation;
  closeAttempt?: Promise<void>;
}

interface FixtureEntry {
  root: string | undefined;
  creation: Promise<unknown> | undefined;
  readonly acquisitions: Set<Promise<unknown>>;
  readonly operations: Set<Promise<unknown>>;
  readonly owners: Map<ProvisionFixtureOwner, OwnerRecord>;
  readonly beforeClose: Map<() => void | Promise<void>, TrackedOperation | undefined>;
  readonly failures: unknown[];
  unsafe: unknown;
}

export class ProvisionFixtureLifetime {
  private readonly entries = new Set<FixtureEntry>();
  private closing = false;
  private cleanupAttempt: Promise<void> | undefined;

  scope(): ProvisionFixtureLifetimeScope {
    if (this.closing) {
      throw new Error('Provision fixture lifetime is closing');
    }
    const entry: FixtureEntry = {
      root: undefined,
      creation: undefined,
      acquisitions: new Set(),
      operations: new Set(),
      owners: new Map(),
      beforeClose: new Map(),
      failures: [],
      unsafe: undefined,
    };
    this.entries.add(entry);
    return new ProvisionFixtureLifetimeScope(this, entry);
  }

  cleanup(): Promise<void> {
    if (this.cleanupAttempt) {
      return this.cleanupAttempt;
    }
    this.closing = true;
    const attempt = this.cleanupEntries();
    this.cleanupAttempt = attempt;
    void attempt.catch(() => {
      if (this.cleanupAttempt === attempt) {
        this.cleanupAttempt = undefined;
      }
    });
    return attempt;
  }

  isClosing() {
    return this.closing;
  }

  private async cleanupEntries() {
    const entries = [...this.entries];
    const attemptFailures: unknown[] = [];
    const ownersClosedBeforeWaiting = new Set(entries.flatMap((entry) => [...entry.owners.keys()]));
    const pendingEntries = new Set(
      entries.filter(
        (entry) =>
          entry.creation !== undefined || entry.acquisitions.size > 0 || entry.operations.size > 0,
      ),
    );

    const finalizers = await Promise.allSettled(
      entries.flatMap((entry) =>
        [...entry.beforeClose.keys()].map((finalizer) => this.runFinalizer(entry, finalizer)),
      ),
    );
    attemptFailures.push(...this.rejectedReasons(finalizers));

    const initialOwnerResults = await Promise.allSettled(
      entries.flatMap((entry) =>
        [...entry.owners.values()]
          .filter(
            (record) => !ownersClosedBeforeWaiting.has(record.owner) || pendingEntries.has(entry),
          )
          .map((owner) => this.closeOwner(entry, owner)),
      ),
    );
    this.collectOwnerAttemptFailures(initialOwnerResults, attemptFailures);

    const pendingOperations = await Promise.allSettled(
      entries.map((entry) =>
        observeFixtureCleanup(
          Promise.allSettled([
            ...(entry.creation ? [entry.creation] : []),
            ...entry.acquisitions,
            ...entry.operations,
          ]).then(() => undefined),
        ),
      ),
    );
    attemptFailures.push(...this.rejectedReasons(pendingOperations));

    const remainingOwnerResults = await Promise.allSettled(
      entries.flatMap((entry) =>
        [...entry.owners.values()].map((owner) => this.closeOwner(entry, owner)),
      ),
    );
    this.collectOwnerAttemptFailures(remainingOwnerResults, attemptFailures);

    const errors: unknown[] = [];
    const addError = (error: unknown) => {
      if (!errors.includes(error)) {
        errors.push(error);
      }
    };
    attemptFailures.forEach(addError);
    const removable: FixtureEntry[] = [];
    for (const entry of entries) {
      entry.failures.forEach(addError);
      for (const record of entry.owners.values()) {
        const unexpected = this.unexpectedCloseFailures(record);
        if (unexpected.length > 0) {
          addError(
            new AggregateError(unexpected, 'Provision fixture owner close failed after release'),
          );
        }
        const pendingClose = record.closeOperations.some(
          (operation) => operation.settlement.kind === 'pending',
        );
        const pendingRelease = record.releaseOperation?.settlement.kind === 'pending';
        if (pendingClose || pendingRelease) {
          addError(new Error('Provision fixture owner cleanup remains unconfirmed'));
        }
      }
      if (
        entry.unsafe !== undefined ||
        entry.owners.size > 0 ||
        entry.beforeClose.size > 0 ||
        entry.creation !== undefined ||
        entry.acquisitions.size > 0 ||
        entry.operations.size > 0
      ) {
        errors.push(
          new Error('Provision fixture root retained because resource ownership is unconfirmed'),
        );
        continue;
      }
      if (entry.failures.length > 0) {
        continue;
      }
      removable.push(entry);
    }

    const removed = await Promise.allSettled(
      removable.map(async (entry) => {
        if (entry.root !== undefined) {
          await rm(entry.root, { recursive: true, force: true });
          entry.root = undefined;
        }
        this.entries.delete(entry);
      }),
    );
    for (const result of removed) {
      if (result.status === 'rejected') {
        errors.push(result.reason);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        'Provision fixture cleanup failed; unresolved roots retained',
      );
    }
  }

  private async runFinalizer(entry: FixtureEntry, finalizer: () => void | Promise<void>) {
    let operation = entry.beforeClose.get(finalizer);
    if (!operation) {
      operation = trackOperation(Promise.resolve().then(finalizer), (error) => {
        if (!entry.failures.includes(error)) {
          entry.failures.push(error);
        }
      });
      entry.beforeClose.set(finalizer, operation);
    }
    const observation = await observeOperation(operation);
    if (observation.kind === 'unconfirmed') {
      throw observation.error;
    }
    if (observation.settlement.kind === 'rejected') {
      throw observation.settlement.error;
    }
    entry.beforeClose.delete(finalizer);
  }

  private rejectedReasons(results: readonly PromiseSettledResult<unknown>[]) {
    return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  }

  private collectOwnerAttemptFailures(
    results: readonly PromiseSettledResult<void>[],
    failures: unknown[],
  ) {
    for (const result of results) {
      if (
        result.status === 'rejected' &&
        !(result.reason instanceof OwnerStateFailure) &&
        !failures.includes(result.reason)
      ) {
        failures.push(result.reason);
      }
    }
  }

  async acquire<Result>(
    entry: FixtureEntry,
    operation: () => Promise<Result>,
    ownerOf: (result: Result) => ProvisionFixtureOwner | undefined,
    isBusy: (result: Result) => boolean,
    expectedCloseFailure: (error: unknown) => boolean,
  ): Promise<Result> {
    this.assertOpen();
    const opening = Promise.resolve().then(operation);
    const tracked = opening.then(
      (result) => {
        const owner = ownerOf(result);
        if (owner) {
          this.registerOwner(entry, owner, expectedCloseFailure);
          const ownerRecord = entry.owners.get(owner);
          if (this.closing && ownerRecord) {
            void this.closeOwner(entry, ownerRecord).catch(() => undefined);
          }
        } else if (isBusy(result) && entry.owners.size === 0) {
          entry.unsafe ??= new Error('Provision fixture acquisition found an unowned busy server');
        }
        return result;
      },
      (error: unknown) => {
        if (!(error instanceof PublishedControlError && error.ownership === 'released')) {
          entry.unsafe ??= error;
        }
        throw error;
      },
    );
    this.trackPending(entry.acquisitions, tracked);
    void tracked.catch(() => undefined);
    return tracked;
  }

  registerOwner(
    entry: FixtureEntry,
    owner: ProvisionFixtureOwner,
    expectedCloseFailure: (error: unknown) => boolean = () => false,
  ) {
    const existing = entry.owners.get(owner);
    if (existing) {
      existing.expectedCloseFailure = expectedCloseFailure;
      return;
    }
    entry.owners.set(owner, {
      owner,
      closeOperations: [],
      closeFailures: new Set(),
      expectedCloseFailure,
    });
  }

  requestOwnerClose(entry: FixtureEntry, record: OwnerRecord): Promise<void> {
    if (entry.owners.get(record.owner) !== record) {
      throw new Error('Provision fixture owner is not registered');
    }
    const promise = Promise.resolve().then(() => record.owner.close());
    const operation = trackOperation(promise, (error) => record.closeFailures.add(error));
    record.closeOperations.push(operation);
    return operation.promise;
  }

  closeOwner(entry: FixtureEntry, record: OwnerRecord): Promise<void> {
    if (record.closeAttempt) {
      return record.closeAttempt;
    }
    let attempt: Promise<void>;
    attempt = this.observeOwner(entry, record).finally(() => {
      if (record.closeAttempt === attempt) {
        delete record.closeAttempt;
      }
    });
    record.closeAttempt = attempt;
    return attempt;
  }

  private async observeOwner(entry: FixtureEntry, record: OwnerRecord) {
    if (entry.owners.get(record.owner) !== record) {
      throw new Error('Provision fixture owner is not registered');
    }
    const pendingClose = record.closeOperations.some(
      (operation) => operation.settlement.kind === 'pending',
    );
    const successfulClose = record.closeOperations.some(
      (operation) => operation.settlement.kind === 'fulfilled',
    );
    if (!pendingClose && !successfulClose) {
      void this.requestOwnerClose(entry, record);
    }
    if (!record.releaseOperation) {
      record.releaseOperation = trackOperation(
        Promise.resolve().then(() => record.owner.ownershipReleased()),
        (error) => {
          if (!entry.failures.includes(error)) {
            entry.failures.push(error);
          }
        },
      );
    }
    const deadline = Date.now() + OWNER_CLEANUP_OBSERVATION_MS;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
    });
    try {
      while (true) {
        const closeSnapshot = [...record.closeOperations];
        const releaseOperation = record.releaseOperation;
        if (!releaseOperation) {
          throw new Error('Provision fixture owner release was not registered');
        }
        // A close can be appended while this snapshot settles; re-read under one deadline.
        // oxlint-disable-next-line eslint/no-await-in-loop -- The repeated snapshot is required to drain concurrent close requests.
        const observation = await Promise.race([
          Promise.all(
            [releaseOperation, ...closeSnapshot].map((operation) => operation.settlementPromise),
          ).then(() => 'settled' as const),
          timedOut,
        ]);

        if (observation === 'timeout') {
          const currentOperations = [releaseOperation, ...record.closeOperations];
          if (currentOperations.some((operation) => operation.settlement.kind === 'pending')) {
            throw new OwnerObservationTimeoutError();
          }
        } else if (record.closeOperations.length !== closeSnapshot.length) {
          continue;
        }

        const currentCloseOperations = [...record.closeOperations];
        const currentOperations = [releaseOperation, ...currentCloseOperations];
        if (currentOperations.some((operation) => operation.settlement.kind === 'pending')) {
          continue;
        }
        if (entry.owners.get(record.owner) !== record) {
          throw new Error('Provision fixture owner is not registered');
        }
        if (record.closeOperations.length !== currentCloseOperations.length) {
          continue;
        }

        if (releaseOperation.settlement.kind === 'rejected') {
          throw new OwnerStateFailure(
            [releaseOperation.settlement.error, ...this.unexpectedCloseFailures(record)],
            'Provision fixture owner release failed',
          );
        }

        const unexpected = this.unexpectedCloseFailures(record);
        if (unexpected.length > 0) {
          throw new OwnerStateFailure(
            unexpected,
            'Provision fixture owner close failed after release',
          );
        }

        // No await between the final registry checks and deletion: a new request
        // either joins this observation or sees the owner as unregistered.
        if (entry.owners.get(record.owner) !== record) {
          throw new Error('Provision fixture owner is not registered');
        }
        if (
          record.closeOperations.some((operation) => operation.settlement.kind === 'pending') ||
          record.releaseOperation.settlement.kind === 'pending'
        ) {
          continue;
        }
        entry.owners.delete(record.owner);
        return;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private unexpectedCloseFailures(record: OwnerRecord) {
    return [...record.closeFailures].filter((failure) => {
      try {
        return !record.expectedCloseFailure(failure);
      } catch {
        return true;
      }
    });
  }

  track<T>(
    entry: FixtureEntry,
    operations: Set<Promise<unknown>>,
    operation: Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    this.trackPending(operations, operation);
    return operation;
  }

  addFinalizer(entry: FixtureEntry, finalizer: () => void | Promise<void>) {
    this.assertOpen();
    entry.beforeClose.set(finalizer, undefined);
  }

  addRoot(entry: FixtureEntry, root: string) {
    if (entry.root !== undefined && entry.root !== root) {
      throw new Error('Provision fixture root changed during creation');
    }
    entry.root = root;
  }

  trackCreation(entry: FixtureEntry, creation: Promise<unknown>) {
    entry.creation = creation;
    void creation.then(
      () => {
        if (entry.creation === creation) {
          entry.creation = undefined;
        }
      },
      () => {
        if (entry.creation === creation) {
          entry.creation = undefined;
        }
      },
    );
  }

  assertOpen() {
    if (this.closing) {
      throw new Error('Provision fixture is closing');
    }
  }

  private trackPending(operations: Set<Promise<unknown>>, operation: Promise<unknown>) {
    operations.add(operation);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
  }
}

export class ProvisionFixtureLifetimeScope {
  constructor(
    private readonly lifetime: ProvisionFixtureLifetime,
    private readonly entry: FixtureEntry,
  ) {}

  create<Fixture extends { readonly root: string }>(
    factory: (registerRoot: (root: string) => void) => Promise<Fixture>,
  ): Promise<Fixture> {
    this.lifetime.assertOpen();
    const creation = Promise.resolve().then(() =>
      factory((root) => this.lifetime.addRoot(this.entry, root)),
    );
    this.lifetime.trackCreation(this.entry, creation);
    return creation.then((fixture) => {
      if (this.lifetime.isClosing()) {
        throw new Error('Provision fixture is closing');
      }
      if (fixture.root !== this.entry.root) {
        throw new Error('Provision fixture root was not registered');
      }
      return fixture;
    });
  }

  acquire<Result>(
    operation: () => Promise<Result>,
    ownerOf: (result: Result) => ProvisionFixtureOwner | undefined,
    isBusy: (result: Result) => boolean = () => false,
    expectedCloseFailure: (error: unknown) => boolean = () => false,
  ) {
    return this.lifetime.acquire(this.entry, operation, ownerOf, isBusy, expectedCloseFailure);
  }

  observe<T>(operation: Promise<T>) {
    return this.lifetime.track(this.entry, this.entry.operations, operation);
  }

  registerOwner(
    owner: ProvisionFixtureOwner,
    expectedCloseFailure: (error: unknown) => boolean = () => false,
  ) {
    this.lifetime.registerOwner(this.entry, owner, expectedCloseFailure);
  }

  closeOwner(owner: ProvisionFixtureOwner) {
    const record = this.entry.owners.get(owner);
    if (!record) {
      throw new Error('Provision fixture owner was not registered');
    }
    return this.lifetime.closeOwner(this.entry, record);
  }

  requestOwnerClose(owner: ProvisionFixtureOwner) {
    const record = this.entry.owners.get(owner);
    if (!record) {
      throw new Error('Provision fixture owner was not registered');
    }
    return this.lifetime.requestOwnerClose(this.entry, record);
  }

  beforeClose(finalizer: () => void | Promise<void>) {
    this.lifetime.addFinalizer(this.entry, finalizer);
  }

  run<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.lifetime.assertOpen();
    const task = Promise.resolve().then(operation);
    void this.lifetime.track(this.entry, this.entry.operations, task);
    return this.finishRun(task);
  }

  cleanup() {
    return this.lifetime.cleanup();
  }

  private async finishRun<Result>(task: Promise<Result>): Promise<Result> {
    let outcome:
      | { readonly kind: 'resolved'; readonly value: Result }
      | { readonly kind: 'rejected'; readonly error: unknown };
    try {
      outcome = { kind: 'resolved', value: await task };
    } catch (error) {
      outcome = { kind: 'rejected', error };
    }

    try {
      await this.lifetime.cleanup();
    } catch (cleanupFailure) {
      if (outcome.kind === 'rejected') {
        // oxlint-disable-next-line eslint/preserve-caught-error -- Both failures remain in AggregateError.errors.
        throw new AggregateError(
          [outcome.error, cleanupFailure],
          'Provision scenario and fixture cleanup both failed',
          { cause: cleanupFailure },
        );
      }
      throw cleanupFailure;
    }
    if (outcome.kind === 'rejected') {
      throw outcome.error;
    }
    return outcome.value;
  }
}
