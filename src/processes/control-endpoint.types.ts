import type { ProcessIdentity } from './process-identity.types.js';

export interface ControlRecord {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly token: string;
  readonly version: string;
  readonly channel: string;
  readonly canonicalDataDir: string;
  readonly endpoint: string;
  readonly process: ProcessIdentity;
}

export interface ControlLimits {
  readonly timeoutMs: number;
  readonly maxFrameBytes: number;
}

export type ControlServerStatus = {
  readonly phase: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'unknown';
  readonly code?: string;
  readonly operationId?: string;
  readonly host?: string;
  readonly port?: number;
  readonly publicUrl?: string;
  readonly ownership?: 'retained' | 'unconfirmed';
};

export interface ListenControlEndpointRequest {
  readonly runtimeDir: string;
  readonly instanceId: string;
  readonly token: string;
  readonly identity: Omit<ControlRecord, 'schemaVersion' | 'instanceId' | 'token' | 'endpoint'>;
  readonly limits?: ControlLimits;
  readonly onStop: () => ControlStopCompletion | void | Promise<ControlStopCompletion | void>;
  readonly onStatus?: () => ControlServerStatus | Promise<ControlServerStatus>;
}

export type ControlStopCompletion =
  | { readonly kind: 'completed' }
  | { readonly kind: 'failed'; readonly ownership: 'retained' | 'unconfirmed' };

export type ControlStopResponse =
  | { readonly kind: 'completed' }
  | {
      readonly kind: 'failed';
      readonly ownership: 'retained' | 'unconfirmed';
      readonly error: SafeControlStopError;
    };

export type ControlStatusResponse = ControlServerStatus;

export type ControlStopDeliveryResult = { readonly kind: 'sent' } | { readonly kind: 'failed' };

export type ControlStopResult =
  | { readonly kind: 'not-requested' }
  | { readonly kind: 'completed' }
  | { readonly kind: 'failed'; readonly error: SafeControlStopError };

export interface SafeControlStopError {
  readonly code: 'CONTROL_STOP_FAILED';
  readonly message: 'Control stop callback failed';
}

export interface HeldControlEndpoint {
  readonly endpoint: string;
  readonly stopResult: Promise<ControlStopResult>;
  readonly stopDelivery: Promise<ControlStopDeliveryResult>;
  close(): Promise<void>;
}

export const DEFAULT_CONTROL_LIMITS: ControlLimits = Object.freeze({
  timeoutMs: 5_000,
  maxFrameBytes: 16_384,
});
