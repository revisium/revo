import type { StartupProgressFacade, StartupProgressOptions } from '../startup-progress/index.js';
import type { ControlRecord, ControlStopResult } from './control-endpoint.types.js';

export type ControlDiscovery =
  | { readonly kind: 'found'; readonly record: ControlRecord }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

export interface OpenPublishedControlRequest {
  readonly dataDir: string;
  readonly runtimeDir: string;
  readonly version: string;
  readonly channel: string;
  readonly limits?: import('./control-endpoint.types.js').ControlLimits;
  readonly onStop: () => void | Promise<void>;
  readonly startupProgress?: StartupProgressOptions;
}

export type PublishedControl =
  | { readonly kind: 'busy' }
  | {
      readonly kind: 'held';
      readonly endpoint: string;
      readonly stopResult: Promise<ControlStopResult>;
      readonly progress?: StartupProgressFacade;
      close(): Promise<void>;
    };
