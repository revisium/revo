export interface StartDatabaseRequest {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface StartedEmbeddedDatabase {
  readonly database: 'revo';
  readonly host: '127.0.0.1';
  readonly kind: 'embedded';
  readonly port: number;
}

export interface StartedExternalDatabase {
  readonly kind: 'external';
}

export type StartedDatabase = StartedEmbeddedDatabase | StartedExternalDatabase;
