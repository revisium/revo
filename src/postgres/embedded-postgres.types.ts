export interface EmbeddedPostgresBinaries {
  readonly initdb: string;
  readonly pgCtl: string;
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
  readonly pgCtl: string;
  readonly postgres: string;
}

export type EmbeddedPostgresFailureReason =
  | 'cancelled'
  | 'invalid'
  | 'locked'
  | 'process'
  | 'unsupported';

export interface EmbeddedPostgresDiagnostic {
  readonly detail?: string;
  readonly logPath?: string;
}

export class EmbeddedPostgresError extends Error {
  readonly code = 'EMBEDDED_POSTGRES_ERROR';
  readonly observedCompletion?: {
    readonly exitCode: number | null;
    readonly signal: string | null;
  };
  readonly detail?: string;
  readonly logPath?: string;

  constructor(
    readonly reason: EmbeddedPostgresFailureReason,
    readonly progressFailure = false,
    observedCompletion?: { readonly exitCode: number | null; readonly signal: string | null },
    diagnostic: EmbeddedPostgresDiagnostic = {},
  ) {
    super(describeFailure(diagnostic));
    this.name = 'EmbeddedPostgresError';
    if (reason === 'process' && observedCompletion) {
      this.observedCompletion = {
        exitCode: observedCompletion.exitCode,
        signal: observedCompletion.signal,
      };
    }
    if (diagnostic.detail !== undefined) {
      this.detail = diagnostic.detail;
    }
    if (diagnostic.logPath !== undefined) {
      this.logPath = diagnostic.logPath;
    }
  }

  withLog(logPath: string): EmbeddedPostgresError {
    return new EmbeddedPostgresError(this.reason, this.progressFailure, this.observedCompletion, {
      ...this.diagnostic(),
      logPath,
    });
  }

  withProgressFailure(): EmbeddedPostgresError {
    return new EmbeddedPostgresError(this.reason, true, this.observedCompletion, this.diagnostic());
  }

  private diagnostic(): EmbeddedPostgresDiagnostic {
    return {
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      ...(this.logPath === undefined ? {} : { logPath: this.logPath }),
    };
  }
}

function describeFailure({ detail, logPath }: EmbeddedPostgresDiagnostic): string {
  const cause = detail === undefined ? '' : `: ${detail}`;
  const log = logPath === undefined ? '' : `. PostgreSQL log: ${logPath}`;
  return `Embedded PostgreSQL preparation failed${cause}${log}`;
}
