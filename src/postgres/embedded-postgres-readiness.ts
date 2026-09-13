import { Client, type ClientConfig, type QueryResult, type QueryResultRow } from 'pg';

import { EmbeddedPostgresError } from './embedded-postgres.types.js';

const HOST = '127.0.0.1' as const;
const ADMIN_DATABASE = 'postgres' as const;
const APPLICATION_DATABASE = 'revo' as const;
const MAX_TIMER_MILLISECONDS = 2_147_483_647;
const CLEANUP_RESERVE_MILLISECONDS = 100;

export interface EmbeddedPostgresReadinessRequest {
  readonly port: number;
  readonly password: string;
  readonly startupNonce: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export const isPendingEmbeddedPostgresReadiness = (error: unknown) =>
  error instanceof EmbeddedPostgresReadinessPendingError;
export const isTerminalEmbeddedPostgresReadiness = (error: unknown) =>
  error instanceof EmbeddedPostgresReadinessTerminalError;
export const isStartupNonceMismatch = (error: unknown) =>
  error instanceof EmbeddedPostgresReadinessTerminalError && error.kind === 'nonce-mismatch';

/** Internal SQL boundary for a PostgreSQL process whose lifecycle is owned elsewhere. */
export class EmbeddedPostgresReadiness {
  private active: Promise<void> | undefined;
  private readonly clients = new Set<Client>();
  private readonly endings = new WeakMap<Client, Promise<void>>();
  private readonly inFlightSql = new Set<Promise<unknown>>();
  private closing = false;
  private closeOperation: Promise<void> | undefined;
  private cleanupFailed = false;
  private controller: AbortController | undefined;
  private deadline: number | undefined;

  initialize(request: EmbeddedPostgresReadinessRequest): Promise<void> {
    if (this.closing || this.active || this.cleanupFailed) {
      return Promise.reject(new EmbeddedPostgresError(this.closing ? 'cancelled' : 'invalid'));
    }
    try {
      validateRequest(request);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.performInitialize(request).finally(() => {
      this.active = undefined;
      this.controller = undefined;
    });
    this.active = operation;
    return operation;
  }

  close(): Promise<void> {
    this.closing = true;
    this.controller?.abort();
    this.closeOperation ??= this.performClose();
    return this.closeOperation;
  }

  private async performInitialize(request: EmbeddedPostgresReadinessRequest) {
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    const deadline = Date.now() + request.timeoutMs;
    this.deadline = deadline;
    const timer = setTimeout(abort, request.timeoutMs);
    try {
      await this.initializeAdminDatabase(request, controller.signal, deadline);
      await this.inspectApplicationDatabase(request, controller.signal, deadline);
    } catch (error) {
      throw safeError(error, controller.signal);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
    }
  }

  private async initializeAdminDatabase(
    request: EmbeddedPostgresReadinessRequest,
    signal: AbortSignal,
    deadline: number,
  ) {
    await this.withClient(request, ADMIN_DATABASE, signal, deadline, async (query) => {
      await query('SELECT 1');
      const existing = await query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
        [APPLICATION_DATABASE],
      );
      if (existing.rows[0]?.exists) {
        return;
      }
      try {
        await query('CREATE DATABASE revo');
      } catch (error) {
        if (errorCode(error) !== '42P04') {
          throw error;
        }
      }
    });
  }

  private async inspectApplicationDatabase(
    request: EmbeddedPostgresReadinessRequest,
    signal: AbortSignal,
    deadline: number,
  ) {
    await this.withClient(request, APPLICATION_DATABASE, signal, deadline, async (query) => {
      await query('SELECT 1');
    });
  }

  private async withClient(
    request: EmbeddedPostgresReadinessRequest,
    database: string,
    signal: AbortSignal,
    deadline: number,
    action: (query: SqlQuery) => Promise<void>,
  ) {
    rejectCancellation(signal);
    const reserve = Math.min(CLEANUP_RESERVE_MILLISECONDS, Math.floor(request.timeoutMs / 10));
    const sqlDeadline = deadline - reserve;
    rejectDispatch(signal, this.closing, sqlDeadline);
    const client = new Client(clientConfig(request, database, sqlDeadline));
    let rejectClientFailure!: (error: unknown) => void;
    const clientFailure = new Promise<never>((_resolve, reject) => {
      rejectClientFailure = reject;
    });
    void clientFailure.catch(() => undefined);
    const onClientError = (error: unknown) => {
      this.cleanupFailed = true;
      rejectClientFailure(error);
    };
    client.on('error', onClientError);
    this.clients.add(client);
    try {
      try {
        await untilDeadline(Promise.race([client.connect(), clientFailure]), sqlDeadline);
      } catch (error) {
        if (isPendingStartupError(error)) {
          throw new EmbeddedPostgresReadinessPendingError();
        }
        if (isPostgresReportedError(error)) {
          throw new EmbeddedPostgresReadinessTerminalError('postgres-error');
        }
        throw error;
      }
      rejectCancellation(signal);
      await untilDeadline(
        this.observeSql(verifyStartupNonce(client, request.startupNonce)),
        sqlDeadline,
      );
      rejectCancellation(signal);
      const query = <Row extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ) => this.query<Row>(client, text, values, signal, sqlDeadline);
      try {
        await Promise.race([action(query), clientFailure]);
      } catch (error) {
        if (isTransportFailure(error)) {
          this.cleanupFailed = true;
        }
        if (isPostgresReportedError(error)) {
          throw new EmbeddedPostgresReadinessTerminalError('postgres-error');
        }
        throw error;
      }
    } finally {
      await this.drainSql(deadline);
      await this.endClient(client, deadline).catch(() => {
        this.cleanupFailed = true;
      });
      this.clients.delete(client);
      void this.endings.get(client)?.then(
        () => client.removeListener('error', onClientError),
        () => client.removeListener('error', onClientError),
      );
    }
  }

  private async query<Row extends QueryResultRow>(
    client: Client,
    text: string,
    values: readonly unknown[] | undefined,
    signal: AbortSignal,
    deadline: number,
  ) {
    rejectDispatch(signal, this.closing, deadline);
    await untilDeadline(
      this.observeSql(
        client.query("SELECT set_config('statement_timeout', $1, false)", [
          String(remaining(deadline)),
        ]),
      ),
      deadline,
    );
    rejectDispatch(signal, this.closing, deadline);
    const result = this.observeSql(
      values ? client.query<Row>(text, [...values]) : client.query<Row>(text),
    );
    return untilDeadline(result, deadline);
  }

  private observeSql<T>(operation: Promise<T>) {
    this.inFlightSql.add(operation);
    void operation.then(
      () => this.inFlightSql.delete(operation),
      () => this.inFlightSql.delete(operation),
    );
    return operation;
  }

  private async drainSql(deadline: number) {
    if (this.inFlightSql.size === 0) {
      return;
    }
    await untilDeadline(Promise.allSettled(this.inFlightSql), deadline).catch(() => {
      this.cleanupFailed = true;
    });
  }

  private endClient(client: Client, deadline: number) {
    const existing = this.endings.get(client);
    if (existing) {
      return untilDeadline(existing, deadline);
    }
    const ending = client.end();
    void ending.catch(() => undefined);
    this.endings.set(client, ending);
    return untilDeadline(ending, deadline);
  }

  private async performClose() {
    const deadline = this.deadline ?? Date.now() + CLEANUP_RESERVE_MILLISECONDS;
    await untilDeadline(this.active?.catch(() => undefined) ?? Promise.resolve(), deadline).catch(
      () => {
        this.cleanupFailed = true;
      },
    );
    await Promise.allSettled([...this.clients].map((client) => this.endClient(client, deadline)));
    if (this.cleanupFailed || this.clients.size > 0) {
      throw new EmbeddedPostgresError('process');
    }
  }
}

type SqlQuery = <Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[],
) => Promise<QueryResult<Row>>;

const clientConfig = (
  request: EmbeddedPostgresReadinessRequest,
  database: string,
  deadline: number,
): ClientConfig & { replication: string } => ({
  host: HOST,
  port: request.port,
  user: 'postgres',
  password: () => request.password,
  database,
  ssl: false,
  sslnegotiation: 'postgres',
  client_encoding: 'UTF8',
  application_name: 'revo',
  options: `-c client_encoding=UTF8 -c statement_timeout=${remaining(deadline)}`,
  replication: 'false',
  connectionTimeoutMillis: remaining(deadline),
});

const validateRequest = (request: EmbeddedPostgresReadinessRequest) => {
  if (
    request.signal.aborted ||
    !Number.isInteger(request.port) ||
    request.port < 1 ||
    request.port > 65_535 ||
    typeof request.password !== 'string' ||
    request.password.length === 0 ||
    typeof request.startupNonce !== 'string' ||
    request.startupNonce.length === 0 ||
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > MAX_TIMER_MILLISECONDS
  ) {
    throw new EmbeddedPostgresError(request.signal.aborted ? 'cancelled' : 'invalid');
  }
};

const verifyStartupNonce = async (client: Client, expected: string) => {
  const result = await client.query<{ cluster_name: string }>('SHOW cluster_name');
  if (result.rows[0]?.cluster_name !== expected) {
    throw new EmbeddedPostgresReadinessTerminalError('nonce-mismatch');
  }
};

const remaining = (deadline: number) => Math.max(1, deadline - Date.now());

const rejectCancellation = (signal: AbortSignal) => {
  if (signal.aborted) {
    throw new EmbeddedPostgresError('cancelled');
  }
};

const rejectDispatch = (signal: AbortSignal, closing: boolean, deadline: number) => {
  if (signal.aborted || closing || Date.now() >= deadline) {
    throw new EmbeddedPostgresError('cancelled');
  }
};

const safeError = (error: unknown, signal: AbortSignal) => {
  if (error instanceof EmbeddedPostgresError) {
    return error;
  }
  return new EmbeddedPostgresError(signal.aborted ? 'cancelled' : 'process');
};

const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;

const isTransportFailure = (error: unknown) => {
  const code = errorCode(error);
  return code?.startsWith('08') === true || code === '57P01';
};

const isPendingStartupError = (error: unknown) => {
  const code = errorCode(error);
  return code === 'ECONNREFUSED' || code === '57P03';
};
const isPostgresReportedError = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'severity' in error &&
  typeof error.severity === 'string' &&
  errorCode(error) !== undefined;

class EmbeddedPostgresReadinessPendingError extends EmbeddedPostgresError {
  constructor() {
    super('process');
  }
}

class EmbeddedPostgresReadinessTerminalError extends EmbeddedPostgresError {
  constructor(readonly kind: 'nonce-mismatch' | 'postgres-error') {
    super('process');
  }
}

async function untilDeadline<T>(operation: Promise<T>, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new EmbeddedPostgresError('process')), remaining(deadline));
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
