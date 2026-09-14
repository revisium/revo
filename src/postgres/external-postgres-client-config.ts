import type { ClientConfig } from 'pg';
import { parseIntoClientConfig } from 'pg-connection-string';

const DEFAULT_PORT = 5432 as const;
const DEFAULT_USER = 'postgres' as const;

/** A safe, intentionally small error for invalid operator-supplied database URLs. */
export class ExternalPostgresConfigurationError extends Error {
  readonly code = 'revo.postgres.external.invalid';

  constructor() {
    super('Invalid external PostgreSQL connection URL');
    this.name = 'ExternalPostgresConfigurationError';
  }
}

/**
 * Converts the supported external URL contract into an explicit pg client config.
 * Validation happens before pg-connection-string so its broader URL grammar cannot
 * accidentally enable connection-string options or environment-based behaviour.
 */
export const buildExternalPostgresClientConfig = (connectionUrl: string): ClientConfig => {
  try {
    validateUrl(connectionUrl);
    const config = parseIntoClientConfig(connectionUrl);
    const sslMode = new URL(connectionUrl).searchParams.get('sslmode') ?? 'verify-full';
    const user = config.user || DEFAULT_USER;
    const password = typeof config.password === 'string' ? config.password : undefined;
    const clientConfig: ClientConfig & { replication: string } = {
      host: config.host,
      port: config.port ?? DEFAULT_PORT,
      user,
      database: config.database || user,
      password: () => password ?? '',
      ssl: sslMode === 'disable' ? false : { rejectUnauthorized: true },
      sslnegotiation: 'postgres',
      client_encoding: 'UTF8',
      application_name: 'revo',
      options: '-c client_encoding=UTF8',
      replication: 'false',
    };
    return clientConfig;
  } catch {
    throw new ExternalPostgresConfigurationError();
  }
};

const validateUrl = (connectionUrl: string) => {
  if (typeof connectionUrl !== 'string' || connectionUrl.length === 0) {
    throw new Error('invalid');
  }
  if (/%(?![0-9a-fA-F]{2})/.test(connectionUrl)) {
    throw new Error('invalid');
  }
  const url = new URL(connectionUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('invalid');
  }
  if (url.hash || !url.hostname || url.searchParams.size > 1) {
    throw new Error('invalid');
  }
  if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65_535)) {
    throw new Error('invalid');
  }
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== 'sslmode') || new Set(keys).size !== keys.length) {
    throw new Error('invalid');
  }
  const sslMode = url.searchParams.get('sslmode');
  if (sslMode !== null && sslMode !== 'verify-full' && sslMode !== 'disable') {
    throw new Error('invalid');
  }
};
