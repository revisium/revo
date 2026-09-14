import {
  buildExternalPostgresClientConfig,
  ExternalPostgresConfigurationError,
} from '../postgres/external-postgres-client-config.js';

export interface CoreDatabaseHandoff {
  readonly databaseUrl: string;
}

/** Builds the only database value passed to the Core child. */
export const buildCoreDatabaseHandoff = (connectionUrl: string): CoreDatabaseHandoff => {
  const config = buildExternalPostgresClientConfig(connectionUrl);
  const host = String(config.host);
  const user = String(config.user);
  const database = String(config.database);
  const password = typeof config.password === 'function' ? config.password() : config.password;
  if (typeof password !== 'string') {
    throw new ExternalPostgresConfigurationError();
  }
  const sslMode = config.ssl === false ? 'disable' : 'verify-full';
  const address = host.includes(':') ? `[${host}]` : host;
  return {
    databaseUrl:
      `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
      `@${address}:${String(config.port)}/${encodeURI(database)}` +
      `?sslmode=${sslMode}`,
  };
};
