import { parseIntoClientConfig } from 'pg-connection-string';
import { afterEach, describe, expect, it } from 'vitest';

import { buildCoreChildEnvironment } from '../../src/core-host/core-child-environment.js';
import { buildCoreDatabaseHandoff } from '../../src/core-host/core-database-handoff.js';
import { CoreDatabaseHandoffScenario } from '../support/core-host/core-database-handoff-scenario.js';
import { ClusterFixture } from '../support/postgres/postgres-readiness-scenario.js';

const PASSWORD = 'revo-test-password';
const expectedStages = [
  'application-database-migrations:started',
  'application-database-migrations:completed',
  'dbos-system-migrations:started',
  'dbos-system-migrations:completed',
  'application-bootstrap:started',
  'application-bootstrap:completed',
  'api-readiness:started',
  'api-readiness:completed',
];

describe('Core database handoff', () => {
  const scenario = new CoreDatabaseHandoffScenario();
  const clusters: ClusterFixture[] = [];

  afterEach(async () => {
    const failures: unknown[] = [];
    try {
      await scenario.cleanup();
    } catch (error) {
      failures.push(error);
    }
    if (scenario.hasNoRunningChildren()) {
      const clusterResults = await Promise.allSettled(
        clusters.splice(0).map((cluster) => cluster.close()),
      );
      failures.push(
        ...clusterResults.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        ),
      );
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Core database fixture cleanup failed');
    }
  });

  it('passes explicit credentials through every published Core stage and GraphQL', async () => {
    const cluster = await startCluster();
    const home = await scenario.isolatedHome();
    const result = await scenario.start(
      handoff(cluster.connectionUrl()),
      scenario.safeEnvironment(home),
    );
    expect(stages(result.messages)).toEqual(expectedStages);
    if (result.terminal.type !== 'listening') {
      throw new Error('Core did not publish a listening result');
    }
    await expect(graphql(result.terminal.url)).resolves.toEqual({
      data: { __typename: 'Query' },
    });
    await result.close();
  }, 60_000);

  it('does not fall through to pgpass or hostile ambient PostgreSQL variables', async () => {
    const cluster = await startCluster();
    const connection = parseIntoClientConfig(cluster.connectionUrl());
    if (typeof connection.password !== 'string') {
      throw new Error('PostgreSQL fixture password was not a string');
    }
    const home = await scenario.isolatedHome(
      `${connection.host}:${String(connection.port)}:${connection.user}:${connection.database}:${connection.password}\n`,
    );
    const hostile = {
      HOME: home,
      PATH: '/usr/local/bin:/usr/bin:/bin',
      PGHOST: '127.0.0.1',
      PGPORT: String(cluster.port),
      PGUSER: 'postgres',
      PGPASSWORD: connection.password,
      DATABASE_URL: cluster.connectionUrl(),
      REVO_RUN_DATABASE_URL: cluster.connectionUrl(),
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      CHECKPOINT_DISABLE: 'hostile',
    };
    const safe = buildCoreChildEnvironment(hostile);
    expect(safe.env).toMatchObject({ HOME: home, PGPASSWORD: '', PGPASSFILE: '/dev/null' });
    expect(safe.env.CHECKPOINT_DISABLE).toBe('1');
    expect(safe.env).not.toHaveProperty('PGHOST');
    expect(safe.env).not.toHaveProperty('DATABASE_URL');
    const url = `postgresql://postgres@127.0.0.1:${cluster.port}/postgres?sslmode=disable`;
    const failure = await scenario.startFailure(handoff(url), safe.env);
    expect(failure.error).toMatchObject({
      name: 'CoreHostProcessError',
      code: 'revo.core-host.failed',
    });
    expect(stages(failure.messages)).toEqual([
      'application-database-migrations:started',
      'application-database-migrations:failed',
    ]);
  }, 60_000);

  it('round-trips a slash and space through the installed public connection parser', () => {
    const database = 'revo/reserved name';
    const url = `postgresql://postgres:${PASSWORD}@127.0.0.1:5432/${database}?sslmode=disable`;
    expect(parseIntoClientConfig(handoff(url)).database).toBe(database);
  });

  function startCluster() {
    return ClusterFixture.start('scram').then((cluster) => {
      clusters.push(cluster);
      return cluster;
    });
  }
});

const handoff = (url: string) => buildCoreDatabaseHandoff(url).databaseUrl;
const stages = (messages: readonly { readonly type: string }[]) =>
  messages.flatMap((message) =>
    message.type === 'stage' && 'stage' in message && 'status' in message
      ? [`${String(message.stage)}:${String(message.status)}`]
      : [],
  );
const graphql = (url: string) =>
  fetch(`${url}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ __typename }' }),
  }).then((response) => response.json());
