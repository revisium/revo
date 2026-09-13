export interface LinuxProcessIdentity {
  readonly platform: 'linux';
  readonly pid: number;
  readonly uid: number;
  readonly birth: { readonly bootId: string; readonly startTicks: string };
}

export interface DarwinProcessIdentity {
  readonly platform: 'darwin';
  readonly pid: number;
  readonly uid: number;
  readonly birth: { readonly seconds: string; readonly microseconds: string };
}

export type ProcessIdentity = LinuxProcessIdentity | DarwinProcessIdentity;
export type ProcessIdentityInspection =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'mismatch' }
  | {
      readonly kind: 'unknown';
      readonly reason: 'invalid-record' | 'unavailable' | 'denied' | 'malformed' | 'unstable';
    };

export type IdentityObservation =
  | { readonly kind: 'captured'; readonly identity: ProcessIdentity }
  | { readonly kind: 'missing' }
  | Exclude<
      ProcessIdentityInspection,
      { readonly kind: 'confirmed' } | { readonly kind: 'mismatch' }
    >;

export interface ProcessIdentityAdapter {
  capture(pid: number): Promise<IdentityObservation>;
}
