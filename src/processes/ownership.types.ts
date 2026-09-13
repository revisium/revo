export interface HeldServerOwnership {
  readonly kind: 'held';
  readonly lockPath: string;
  release(): Promise<void>;
}

export type ServerOwnership = HeldServerOwnership | { readonly kind: 'busy' };
