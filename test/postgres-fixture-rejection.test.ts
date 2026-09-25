import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EmbeddedPostgresPreparationService } from '../src/postgres/embedded-postgres-preparation.service.js';
import { EmbeddedPostgresResourceService } from '../src/postgres/embedded-postgres-resource.service.js';
import { EmbeddedPostgresError } from '../src/postgres/embedded-postgres.types.js';
import { OwnedStartupProgress } from '../src/startup-progress/startup-progress-facade.js';
import { StartupProgressJournalWriter } from '../src/startup-progress/startup-progress-journal.service.js';
import { TrackedPostgresProcesses } from './support/postgres/tracked-postgres-processes.js';

describe('PostgreSQL fixture rejection ownership', () => {
  it('records marker hook failure after physical exit without an unhandled rejection', async () => {
    const root = await mkdtemp('/tmp/revo-postgres-hook-failure-');
    const dataDir = join(root, 'data');
    await mkdir(dataDir, { mode: 0o700 });
    const processes = new TrackedPostgresProcesses({ postmasterPidAfterExit: 'symlink' });
    const progress = new OwnedStartupProgress(new StartupProgressJournalWriter(), dataDir, {
      operationId: '99999999999999999999999999999999',
      now: () => performance.now(),
    });
    const resource = new EmbeddedPostgresResourceService(
      new EmbeddedPostgresPreparationService(processes),
      processes,
    ).bind(dataDir, progress);
    const unhandled: { readonly reason: unknown; readonly promise: Promise<unknown> }[] = [];
    const onUnhandledRejection = (reason: unknown, promise: Promise<unknown>) => {
      unhandled.push({ reason, promise });
    };
    process.on('unhandledRejection', onUnhandledRejection);
    let physicalExitConfirmed = false;

    try {
      await progress.initialize();
      await resource.prepareEmbeddedPostgres({
        signal: new AbortController().signal,
        timeoutMs: 120_000,
      });
      const clusterDir = join(dataDir, 'postgres');
      await mkdir(`${clusterDir}/postmaster.pid.fixture-target`);
      await resource.start({ signal: new AbortController().signal, timeoutMs: 60_000 });

      const fixtureStop = processes.stopPostgresForFixture().then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
      const physicalCompletion = processes.physicalPostgresCompletion;
      if (!physicalCompletion) {
        throw new Error('Physical PostgreSQL completion observer missing');
      }
      const completion = await physicalCompletion;
      physicalExitConfirmed = true;
      const stopResult = await fixtureStop;
      expect(completion).toMatchObject({ exitCode: 0, signal: null });
      expect(stopResult.kind).toBe('rejected');
      if (stopResult.kind !== 'rejected') {
        throw new Error('Marker hook unexpectedly resolved');
      }
      expect(errorCode(stopResult.error)).toBe('EISDIR');
      expect(await processes.completion?.catch((error: unknown) => error)).toBe(stopResult.error);

      const closeResult = await resource.close().then(
        () => 'resolved' as const,
        (error: unknown) =>
          error instanceof EmbeddedPostgresError ? ('rejected' as const) : ('wrong-error' as const),
      );
      expect(closeResult).toBe('rejected');
      await progress.close();

      const drainResult = await processes.drain().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(drainResult).toBeInstanceOf(AggregateError);
      if (!(drainResult instanceof AggregateError)) {
        throw new Error('Fixture drain did not preserve the marker hook failure');
      }
      expect(drainResult.errors).toContain(stopResult.error);
    } finally {
      try {
        if (!physicalExitConfirmed) {
          await processes.release().catch(() => undefined);
          const physicalCompletion = processes.physicalPostgresCompletion;
          if (physicalCompletion) {
            await physicalCompletion;
            physicalExitConfirmed = true;
          }
        }
        await resource.close().catch(() => undefined);
        await progress.close().catch(() => undefined);
        const drainResult = await processes.drain().then(
          () => undefined,
          (error: unknown) => error,
        );
        if (physicalExitConfirmed) {
          await rm(root, { recursive: true, force: true });
        }
        const cleanupDrainConfirmed =
          drainResult === undefined ||
          (drainResult instanceof AggregateError &&
            drainResult.errors.every((error) => errorCode(error) === 'EISDIR'));
        expect(cleanupDrainConfirmed).toBe(true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
    }
  }, 180_000);
});

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}
