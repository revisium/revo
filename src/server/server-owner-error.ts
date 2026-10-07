import { CoreHostProcessError } from '../core-host/core-host-process.service.js';
import { errorMessage } from '../errors.js';
import { EmbeddedPostgresError, ExternalPostgresError } from '../postgres/index.js';

export type ServerOwnerErrorCode =
  | 'revo.server-owner.cancelled'
  | 'revo.server-owner.core'
  | 'revo.server-owner.database'
  | 'revo.server-owner.filesystem'
  | 'revo.server-owner.invalid-state'
  | 'revo.server-owner.readiness'
  | 'revo.server-owner.stop'
  | 'revo.server-owner.unexpected';

export class ServerOwnerError extends Error {
  constructor(
    readonly code: ServerOwnerErrorCode,
    readonly cleanupCode?: 'revo.server-owner.stop',
    readonly databaseFailure?:
      | {
          readonly code: 'EMBEDDED_POSTGRES_ERROR';
          readonly reason: EmbeddedPostgresError['reason'];
          readonly progressFailure: boolean;
          readonly observedCompletion?: EmbeddedPostgresError['observedCompletion'];
          readonly detail?: string;
          readonly logPath?: string;
        }
      | {
          readonly code: 'revo.postgres.external.lifecycle';
          readonly reason: ExternalPostgresError['reason'];
          readonly detail?: string;
        },
  ) {
    super('Server owner operation failed.');
    this.name = 'ServerOwnerError';
  }
}

export function normalizeOwnerError(error: unknown, signal: AbortSignal): ServerOwnerError {
  if (error instanceof ServerOwnerError) {
    return error;
  }
  if (signal.aborted) {
    return new ServerOwnerError('revo.server-owner.cancelled');
  }
  if (error instanceof CoreHostProcessError) {
    return new ServerOwnerError('revo.server-owner.core');
  }
  if (isDatabaseFailure(error)) {
    return new ServerOwnerError(
      'revo.server-owner.database',
      undefined,
      safeDatabaseFailure(error),
    );
  }
  if (isFileSystemError(error)) {
    return new ServerOwnerError('revo.server-owner.filesystem');
  }
  return new ServerOwnerError('revo.server-owner.unexpected');
}

export function startFailureReason(primary: ServerOwnerError, cause: unknown): string {
  if (primary.code === 'revo.server-owner.database') {
    return `the database did not start (${databaseFailureDetail(primary.databaseFailure)})`;
  }
  if (primary.code === 'revo.server-owner.core') {
    const detail = cause instanceof CoreHostProcessError ? cause.code : errorSummary(cause);
    return `Revo Core did not start (${detail}); its own output above has the cause`;
  }
  if (primary.code === 'revo.server-owner.filesystem') {
    return `a file system operation failed (${errorMessage(cause)})`;
  }
  if (primary.code === 'revo.server-owner.readiness') {
    return 'Revo Core did not pass its readiness check';
  }
  if (primary.code === 'revo.server-owner.cancelled') {
    return 'the start was cancelled or exceeded its startup timeout';
  }
  if (primary.code === 'revo.server-owner.unexpected') {
    return `an unexpected error occurred (${errorSummary(cause)})`;
  }
  return `${primary.code} (${errorSummary(cause)})`;
}

function databaseFailureDetail(failure: ServerOwnerError['databaseFailure']): string {
  if (!failure) {
    return 'unknown database failure';
  }
  if (failure.code === 'revo.postgres.external.lifecycle') {
    const detail = failure.detail === undefined ? '' : `: ${failure.detail}`;
    return `external PostgreSQL ${failure.reason} failure${detail}`;
  }
  const exit = failure.observedCompletion
    ? `, exit code ${String(failure.observedCompletion.exitCode)}, signal ${String(failure.observedCompletion.signal)}`
    : '';
  const detail = failure.detail === undefined ? '' : `: ${failure.detail}`;
  const log = failure.logPath === undefined ? '' : `; PostgreSQL log: ${failure.logPath}`;
  return `embedded PostgreSQL ${failure.reason} failure${exit}${detail}${log}`;
}

const errorSummary = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const isFileSystemError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error &&
  typeof Reflect.get(error, 'syscall') === 'string' &&
  typeof Reflect.get(error, 'path') === 'string';

export const isDatabaseFailure = (
  error: unknown,
): error is EmbeddedPostgresError | ExternalPostgresError =>
  error instanceof EmbeddedPostgresError || error instanceof ExternalPostgresError;

export function safeDatabaseFailure(
  error: EmbeddedPostgresError | ExternalPostgresError,
): ServerOwnerError['databaseFailure'] {
  if (error instanceof EmbeddedPostgresError) {
    return {
      code: error.code,
      reason: error.reason,
      progressFailure: error.progressFailure,
      ...embeddedDiagnostic(error),
    };
  }
  return externalDiagnostic(error);
}

/** Copies the reason and Revo's one-line description of the connection failure. */
function externalDiagnostic(
  error: ExternalPostgresError,
): Extract<ServerOwnerError['databaseFailure'], { code: ExternalPostgresError['code'] }> {
  if (error.detail === undefined) {
    return { code: error.code, reason: error.reason };
  }
  return { code: error.code, reason: error.reason, detail: error.detail };
}

/** Copies only the fields Revo itself composed: exit status, refusal detail, and log path. */
function embeddedDiagnostic(error: EmbeddedPostgresError) {
  const diagnostic: {
    observedCompletion?: EmbeddedPostgresError['observedCompletion'];
    detail?: string;
    logPath?: string;
  } = {};
  if (error.observedCompletion) {
    diagnostic.observedCompletion = {
      exitCode: error.observedCompletion.exitCode,
      signal: error.observedCompletion.signal,
    };
  }
  if (error.detail !== undefined) {
    diagnostic.detail = error.detail;
  }
  if (error.logPath !== undefined) {
    diagnostic.logPath = error.logPath;
  }
  return diagnostic;
}
