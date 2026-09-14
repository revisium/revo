import { describe, expect, it } from 'vitest';

import {
  buildExternalPostgresClientConfig,
  ExternalPostgresConfigurationError,
} from '../../src/postgres/external-postgres-client-config.js';

class ExternalPostgresUrlScenario {
  constructor(private readonly url: string) {}

  config() {
    return buildExternalPostgresClientConfig(this.url);
  }

  failure() {
    try {
      this.config();
      return undefined;
    } catch (error) {
      return error;
    }
  }
}

describe('external PostgreSQL client configuration', () => {
  it('builds explicit TLS config and neutralizes ambient PostgreSQL settings', () => {
    const config = new ExternalPostgresUrlScenario(
      'postgresql://encoded%20user:secret%20password@db.example/revo%20db',
    ).config();

    expect(config).toMatchObject({
      host: 'db.example',
      port: 5432,
      user: 'encoded user',
      database: 'revo db',
      ssl: { rejectUnauthorized: true },
      sslnegotiation: 'postgres',
      client_encoding: 'UTF8',
      application_name: 'revo',
      options: '-c client_encoding=UTF8',
      replication: 'false',
    });
    expect(typeof config.password === 'function' ? config.password() : config.password).toBe(
      'secret password',
    );
    expect(config.connectionString).toBeUndefined();
  });

  it('resolves the database default from the resolved user and supports empty credentials', () => {
    const config = new ExternalPostgresUrlScenario(
      'postgres://db.example?sslmode=disable',
    ).config();

    expect(config).toMatchObject({
      user: 'postgres',
      database: 'postgres',
      port: 5432,
      ssl: false,
    });
    expect(typeof config.password === 'function' ? config.password() : config.password).toBe('');
  });

  it('uses an explicit user as the database default', () => {
    expect(new ExternalPostgresUrlScenario('postgres://alice@db.example').config()).toMatchObject({
      user: 'alice',
      database: 'alice',
    });
  });

  it.each([
    'postgres://db.example?sslmode=require',
    'postgres://db.example?sslmode=disable&sslmode=verify-full',
    'postgres://db.example?sslmode=verify-full&application_name=leak',
    'postgres://db.example?sslrootcert=/tmp/ca.pem',
    'postgres://db.example:0/postgres',
    'postgres://db.example#fragment',
    'postgres://db.example/%ZZ',
    'file:///tmp/postgres.conf',
  ])('rejects unsupported or malformed URL %s with a safe error', (url) => {
    const error = new ExternalPostgresUrlScenario(url).failure();

    expect(error).toBeInstanceOf(ExternalPostgresConfigurationError);
    expect(error).toMatchObject({ code: 'revo.postgres.external.invalid' });
    expect(String(error)).not.toContain('tmp');
  });
});
