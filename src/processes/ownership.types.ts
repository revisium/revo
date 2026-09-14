export interface HeldServerOwnership {
  readonly kind: 'held';
  readonly lockPath: string;
  release(): Promise<void>;
}

export type ServerOwnership = HeldServerOwnership | { readonly kind: 'busy' };

export type ServerOwnershipInspection =
  | { readonly kind: 'missing' }
  | { readonly kind: 'free'; readonly lockPath: string }
  | { readonly kind: 'busy'; readonly lockPath: string }
  | { readonly kind: 'unavailable' };
