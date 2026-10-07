interface LinuxProcessIdentity {
  readonly platform: 'linux';
  readonly pid: number;
  readonly uid: number;
  readonly birth: { readonly bootId: string; readonly startTicks: string };
}

interface DarwinProcessIdentity {
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
  | { readonly kind: 'restricted'; readonly uid: number }
  | Exclude<
      ProcessIdentityInspection,
      { readonly kind: 'confirmed' } | { readonly kind: 'mismatch' }
    >;

interface DirectoryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export type WorkingDirectoryObservation =
  | { readonly kind: 'captured'; readonly directory: DirectoryIdentity }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unknown' };

export interface ProcessIdentityAdapter {
  capture(pid: number): Promise<IdentityObservation>;
  workingDirectory(pid: number): Promise<WorkingDirectoryObservation>;
}
