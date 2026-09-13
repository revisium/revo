export interface EmbeddedPostgresBinaries {
  readonly initdb: string;
  readonly postgres: string;
}

export interface PrepareEmbeddedPostgresRequest {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface PreparedEmbeddedPostgres {
  readonly clusterDir: string;
  readonly created: boolean;
  readonly majorVersion: 17;
  readonly postgres: string;
}

export class EmbeddedPostgresError extends Error {
  readonly code = 'EMBEDDED_POSTGRES_ERROR';
  constructor(
    readonly reason: 'cancelled' | 'invalid' | 'process' | 'unsupported',
    readonly progressFailure = false,
  ) {
    super('Embedded PostgreSQL preparation failed');
    this.name = 'EmbeddedPostgresError';
  }
}
