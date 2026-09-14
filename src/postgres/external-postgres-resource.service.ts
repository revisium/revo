import { Injectable } from '@nestjs/common';
import { Client, type ClientConfig } from 'pg';

import type { StartupProgressFacade } from '../startup-progress/index.js';
import type {
  StartDatabaseRequest,
  StartedExternalDatabase,
} from './embedded-postgres-resource.types.js';
import { buildExternalPostgresClientConfig } from './external-postgres-client-config.js';

const CLOSE_TIMEOUT_MS = 1000;

export class ExternalPostgresError extends Error {
  readonly code = 'revo.postgres.external.lifecycle';

  constructor(readonly reason: 'cancelled' | 'connection') {
    super('External PostgreSQL lifecycle failed');
    this.name = 'ExternalPostgresError';
  }
}

@Injectable()
export class ExternalPostgresResourceService {
  bind(connectionUrl: string, progress: StartupProgressFacade) {
    return new OwnedExternalPostgresResource(
      buildExternalPostgresClientConfig(connectionUrl),
      progress,
      (config) => new Client(config),
    );
  }
}

export class OwnedExternalPostgresResource {
  private active: Promise<StartedExternalDatabase> | undefined;
  private cancelStart: (() => void) | undefined;
  private client: Client | undefined;
  private closing = false;
  private closeOperation: Promise<void> | undefined;
  private endOperation: Promise<void> | undefined;
  private failure: ExternalPostgresError | undefined;

  constructor(
    private readonly config: ClientConfig,
    private readonly progress: StartupProgressFacade,
    private readonly createClient: (config: ClientConfig) => Client,
  ) {}

  start(request: StartDatabaseRequest): Promise<StartedExternalDatabase> {
    if (
      this.closing ||
      request.signal.aborted ||
      !Number.isInteger(request.timeoutMs) ||
      request.timeoutMs <= 0 ||
      request.timeoutMs > 2_147_483_647
    ) {
      return Promise.reject(new ExternalPostgresError('cancelled'));
    }
    if (this.active) {
      return this.active;
    }
    this.active = this.performStart(request);
    void this.active.catch(() => undefined);
    return this.active;
  }

  close(): Promise<void> {
    this.closing = true;
    this.cancelStart?.();
    this.closeOperation ??= this.performClose();
    return this.closeOperation;
  }

  async settled(): Promise<void> {
    await this.active?.catch(() => undefined);
    await this.endOperation;
  }

  private async performStart(request: StartDatabaseRequest): Promise<StartedExternalDatabase> {
    const deadline = Date.now() + request.timeoutMs;
    const client = this.createClient({
      ...this.config,
      connectionTimeoutMillis: remaining(deadline),
      query_timeout: remaining(deadline),
      options: `${String(this.config.options)} -c statement_timeout=${remaining(deadline)}`,
    });
    this.client = client;
    let cancel!: (failure: ExternalPostgresError) => void;
    const cancelled = new Promise<never>((_resolve, reject) => (cancel = reject));
    void cancelled.catch(() => undefined);
    const fail = (failure: ExternalPostgresError) => {
      this.failure ??= failure;
      cancel(this.failure);
      void this.endClient(client).catch(() => undefined);
    };
    const abort = () => fail(new ExternalPostgresError('cancelled'));
    client.on('error', () => fail(new ExternalPostgresError('connection')));
    this.cancelStart = abort;
    request.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, remaining(deadline));
    timer.unref();
    try {
      await this.progress.start('postgres-connect');
      this.rejectClosing(request.signal);
      await Promise.race([client.connect(), cancelled]);
      this.rejectClosing(request.signal);
      await Promise.race([client.query('SELECT 1'), cancelled]);
      this.rejectClosing(request.signal);
      await this.progress.complete('postgres-connect');
      this.rejectClosing(request.signal);
      return Object.freeze({ kind: 'external' });
    } catch (error) {
      let failure: ExternalPostgresError;
      if (error instanceof ExternalPostgresError) {
        failure = error;
      } else if (this.closing || request.signal.aborted) {
        failure = new ExternalPostgresError('cancelled');
      } else {
        failure = new ExternalPostgresError('connection');
      }
      await this.progress
        .fail('postgres-connect', { code: `POSTGRES_EXTERNAL_${failure.reason.toUpperCase()}` })
        .catch(() => undefined);
      throw failure;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
      if (this.cancelStart === abort) {
        this.cancelStart = undefined;
      }
    }
  }

  private async performClose(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    await bounded(this.endClient(client), CLOSE_TIMEOUT_MS).catch(() => {
      throw new ExternalPostgresError('connection');
    });
    if (this.active) {
      await bounded(
        this.active.then(
          () => undefined,
          () => undefined,
        ),
        CLOSE_TIMEOUT_MS,
      ).catch(() => {
        throw new ExternalPostgresError('connection');
      });
    }
    if (this.failure?.reason === 'connection') {
      throw this.failure;
    }
  }

  private endClient(client: Client) {
    this.endOperation ??= client.end();
    void this.endOperation.catch(() => undefined);
    return this.endOperation;
  }

  private rejectClosing(signal: AbortSignal) {
    if (this.failure) {
      throw this.failure;
    }
    if (this.closing || signal.aborted) {
      throw new ExternalPostgresError('cancelled');
    }
  }
}

const remaining = (deadline: number) => Math.max(1, deadline - Date.now());

const bounded = <T>(operation: Promise<T>, timeoutMs: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ExternalPostgresError('connection')), timeoutMs);
    timer.unref();
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
