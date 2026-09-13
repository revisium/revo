import { afterEach, describe, expect, it } from 'vitest';

import { PostgresReadinessScenario } from '../support/postgres/postgres-readiness-scenario.js';

describe('embedded PostgreSQL SQL readiness', () => {
  let scenario = new PostgresReadinessScenario();
  afterEach(async () => {
    await scenario.cleanup();
    scenario = new PostgresReadinessScenario();
  });

  it('verifies the owned cluster before creating and querying the application database', async () => {
    await expect(scenario.initializesTheOwnedDatabase()).resolves.toEqual({
      databaseExists: true,
      query: 42,
      serverAlive: true,
    });
  });

  it('does not write to a different trust-authenticated PostgreSQL server', async () => {
    await expect(scenario.rejectsAnotherTrustAuthenticatedCluster()).resolves.toEqual({
      outcome: {
        name: 'EmbeddedPostgresError',
        message: 'Embedded PostgreSQL preparation failed',
        hasCause: false,
      },
      databaseExists: false,
      serverAlive: true,
    });
  });

  it('reports bad database authentication without leaking connection details', async () => {
    await expect(scenario.rejectsBadAuthenticationSafely()).resolves.toEqual({
      outcome: {
        name: 'EmbeddedPostgresError',
        message: 'Embedded PostgreSQL preparation failed',
        hasCause: false,
      },
      databaseExists: false,
      serverAlive: true,
    });
  });

  it('close cancels and drains only the readiness SQL operation', async () => {
    await expect(scenario.closeCancelsOnlyItsBlockedSql()).resolves.toEqual({
      outcome: {
        name: 'EmbeddedPostgresError',
        message: 'Embedded PostgreSQL preparation failed',
        hasCause: false,
      },
      closes: ['fulfilled', 'fulfilled'],
      sessionGone: true,
      databaseExists: false,
      serverAlive: true,
    });
  }, 15_000);

  it('enforces the server-side statement timeout for blocked readiness SQL', async () => {
    const result = await scenario.observesServerStatementTimeout();
    expect(result).toMatchObject({
      outcome: {
        name: 'EmbeddedPostgresError',
        message: 'Embedded PostgreSQL preparation failed',
        hasCause: false,
      },
      observedTimeout: true,
      sessionGone: true,
      databaseExists: false,
      serverAlive: true,
    });
    const expectedClose =
      result.close === 'resolved'
        ? 'resolved'
        : {
            name: 'EmbeddedPostgresError',
            message: 'Embedded PostgreSQL preparation failed',
            hasCause: false,
          };
    expect(result.close).toEqual(expectedClose);
  }, 15_000);

  it('converts a terminated blocked SQL connection into a safe owned failure', async () => {
    await expect(scenario.safelyHandlesTerminatedSqlConnection()).resolves.toEqual({
      outcome: {
        name: 'EmbeddedPostgresError',
        message: 'Embedded PostgreSQL preparation failed',
        hasCause: false,
      },
      close: {
        name: 'EmbeddedPostgresError',
        message: 'Embedded PostgreSQL preparation failed',
        hasCause: false,
      },
      sessionGone: true,
      serverAlive: true,
    });
  });

  it('rejects repeated close when transport cannot confirm SQL settlement by the deadline', async () => {
    const failure = {
      name: 'EmbeddedPostgresError',
      message: 'Embedded PostgreSQL preparation failed',
      hasCause: false,
    };
    await expect(scenario.rejectsUnconfirmedSqlDrainAtTheOriginalDeadline()).resolves.toEqual({
      closes: [failure, failure],
      outcome: failure,
      databaseExists: false,
      serverAlive: true,
    });
  }, 20_000);

  it('holds a real loopback port until explicit release', async () => {
    await expect(scenario.reservesAnActualLoopbackPort()).resolves.toEqual({
      whileHeld: false,
      afterRelease: true,
    });
  });
});
