import { afterEach, describe, expect, it, vi } from 'vitest';

const markerRead = vi.hoisted(() => {
  let armed = false;
  let held = false;
  let releasedByWatchdog = false;
  let resolveStarted!: () => void;
  let resolveRelease!: () => void;
  let resolveDelivered!: () => void;
  let started = Promise.resolve();
  let gate = Promise.resolve();
  let delivered = Promise.resolve();

  return {
    arm() {
      armed = true;
      held = false;
      releasedByWatchdog = false;
      started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      gate = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });
      delivered = new Promise<void>((resolve) => {
        resolveDelivered = resolve;
      });
    },
    shouldHold(path: unknown) {
      if (armed && String(path).endsWith('/postmaster.pid')) {
        armed = false;
        held = true;
        resolveStarted();
        return true;
      }
      return false;
    },
    waitForRelease() {
      return gate;
    },
    waitStarted() {
      return started;
    },
    waitDelivered() {
      return delivered;
    },
    release(fromWatchdog = false) {
      if (held) {
        releasedByWatchdog ||= fromWatchdog;
        held = false;
        resolveRelease();
      }
    },
    isHeld() {
      return held;
    },
    wasReleasedByWatchdog() {
      return releasedByWatchdog;
    },
    delivered() {
      resolveDelivered();
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      const metadata = await original.lstat(...args);
      if (markerRead.shouldHold(args[0])) {
        await markerRead.waitForRelease();
        markerRead.delivered();
      }
      return metadata;
    },
  };
});

import { PostgresLifecycleScenario } from './support/postgres/postgres-lifecycle-scenario.js';

describe('bounded PostgreSQL marker observer', () => {
  let scenario: PostgresLifecycleScenario | undefined;

  afterEach(async () => {
    markerRead.release();
    await scenario?.cleanup();
    scenario = undefined;
  }, 35_000);

  it('bounds a pending marker read and keeps ownership until an explicit retry', async () => {
    markerRead.arm();
    scenario = new PostgresLifecycleScenario();
    const watchdog = setTimeout(() => markerRead.release(true), 12_000);
    try {
      const result =
        await scenario.observesUnsafePostgresMarkerBeforeCloseWithoutUnhandledRejection({
          afterRetainedClose: async () => {
            await markerRead.waitStarted();
            expect(markerRead.wasReleasedByWatchdog()).toBe(false);
            expect(markerRead.isHeld()).toBe(true);
            markerRead.release();
            await markerRead.waitDelivered();
          },
        });
      expect(markerRead.wasReleasedByWatchdog()).toBe(false);
      expect(result).toMatchObject({
        unhandledAfterCleanup: 0,
        firstClose: 'retained',
        ownershipPendingWhileMarkerRemains: true,
        busyWhileMarkerRemains: 'busy',
        retryClose: 'released',
        reopenedAfterRelease: 'held',
      });
    } finally {
      clearTimeout(watchdog);
      markerRead.release();
    }
  }, 30_000);

  it('waits for the production marker read before asserting no early unhandled rejection', async () => {
    markerRead.arm();
    scenario = new PostgresLifecycleScenario();
    const watchdog = setTimeout(() => markerRead.release(true), 12_000);
    try {
      const result =
        await scenario.observesUnsafePostgresMarkerBeforeCloseWithoutUnhandledRejection({
          afterMarkerRead: async () => {
            await markerRead.waitStarted();
            expect(markerRead.wasReleasedByWatchdog()).toBe(false);
            expect(markerRead.isHeld()).toBe(true);
            markerRead.release();
            await markerRead.waitDelivered();
          },
        });
      expect(markerRead.wasReleasedByWatchdog()).toBe(false);
      expect(result.unhandledBeforeClose).toBe(0);
      expect(result.unhandledAfterCleanup).toBe(0);
      expect(result.firstClose).toBe('retained');
    } finally {
      clearTimeout(watchdog);
      markerRead.release();
    }
  }, 30_000);
});
