import type {
  PreparedEmbeddedPostgres,
  PrepareEmbeddedPostgresRequest,
  StartedDatabase,
  StartDatabaseRequest,
} from '../postgres/index.js';
import type { StartupProgressFacade, StartupProgressOptions } from '../startup-progress/index.js';
import type {
  ControlRecord,
  ControlStopCompletion,
  ControlServerStatus,
  ControlStopDeliveryResult,
  ControlStopResult,
} from './control-endpoint.types.js';

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
  readonly onStop: () => ControlStopCompletion | void | Promise<ControlStopCompletion | void>;
  readonly onStatus?: () => ControlServerStatus | Promise<ControlServerStatus>;
  readonly startupProgress?: StartupProgressOptions;
  readonly databaseUrl?: string;
}

interface HeldPublishedControlBase {
  readonly kind: 'held';
  readonly canonicalDataDir: string;
  readonly endpoint: string;
  readonly stopResult: Promise<ControlStopResult>;
  readonly stopDelivery: Promise<ControlStopDeliveryResult>;
  readonly progress?: StartupProgressFacade;
  close(): Promise<void>;
}

export type PublishedControl =
  | { readonly kind: 'busy' }
  | (HeldPublishedControlBase & {
      readonly databaseKind: 'embedded';
      prepareEmbeddedPostgres?(
        request: PrepareEmbeddedPostgresRequest,
      ): Promise<PreparedEmbeddedPostgres>;
      startDatabase?(request: StartDatabaseRequest): Promise<StartedDatabase>;
    })
  | (HeldPublishedControlBase & {
      readonly databaseKind: 'external';
      readonly prepareEmbeddedPostgres?: never;
      startDatabase?(request: StartDatabaseRequest): Promise<StartedDatabase>;
    });
