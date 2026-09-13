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

export interface ListenControlEndpointRequest {
  readonly runtimeDir: string;
  readonly instanceId: string;
  readonly token: string;
  readonly identity: Omit<ControlRecord, 'schemaVersion' | 'instanceId' | 'token' | 'endpoint'>;
  readonly limits?: ControlLimits;
  readonly onStop: () => void | Promise<void>;
}

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
  close(): Promise<void>;
}

export const DEFAULT_CONTROL_LIMITS: ControlLimits = Object.freeze({
  timeoutMs: 5_000,
  maxFrameBytes: 16_384,
});
