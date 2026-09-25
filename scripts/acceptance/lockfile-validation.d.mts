export interface TuiLockOverrideExpected {
  name: '@revisium/revo-tui';
  version: string;
  url: string;
  integrity: string;
  tarballSha256: string;
}

export interface TuiLockValidationReceipt {
  policy: 'revo-tui-lock-override-v1';
  documentCount: 2;
  applicationDocumentIndex: 1;
  importer: '.';
  dependency: '@revisium/revo-tui';
  sourceLockSha256: string;
  stagingLockSha256: string;
  sourcePackageKey: string;
  targetPackageKey: string;
  sourceSnapshotKey: string;
  targetSnapshotKey: string;
  peerSuffix: string;
  url: string;
  integrity: string;
  tarballSha256: string;
  version: string;
}

export function validateTuiLockOverride(options: {
  beforeLock: Uint8Array;
  afterLock: Uint8Array;
  sourcePackage: { [key: string]: unknown };
  stagedPackage: { [key: string]: unknown };
  expected: TuiLockOverrideExpected;
}): TuiLockValidationReceipt;

export function validateTuiLockSource(options: {
  sourceLock: Uint8Array;
  sourcePackage: { [key: string]: unknown };
  expected: TuiLockOverrideExpected;
}): {
  policy: 'revo-tui-lock-override-v1';
  sourceLockSha256: string;
  sourcePackageKey: string;
  sourceSnapshotKey: string;
  peerSuffix: string;
};
