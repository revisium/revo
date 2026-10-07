import type { ServerOwnerErrorCode } from './server-owner-error.js';

export interface ServerOwnerConfiguration {
  readonly channel: string;
  readonly dataDir: string;
  readonly databaseUrl?: string;
  readonly host: string;
  readonly logDir: string;
  readonly port: number;
  readonly publicUrl: string;
  readonly runtimeDir: string;
  readonly startupTimeout: number;
  readonly version: string;
}

export interface OpenServerOwnerRequest {
  readonly configuration: ServerOwnerConfiguration;
  readonly environment: NodeJS.ProcessEnv;
  readonly operationId: string;
  readonly trustedEnvironmentNames?: readonly string[];
  readonly executable?: string;
  readonly coreEntry?: string;
  readonly now?: () => number;
}

export interface ServerOwnerReady {
  readonly kind: 'ready';
  readonly url: string;
}

export type ServerOwnerOutcome =
  | { readonly kind: 'stopped' }
  | {
      readonly kind: 'failed';
      readonly code: ServerOwnerErrorCode;
      readonly cleanup: 'completed' | 'retained' | 'unconfirmed';
    };
