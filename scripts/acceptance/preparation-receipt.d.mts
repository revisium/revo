export interface PreparationReceiptInput {
  schemaVersion: 1;
  sourceRevision: string | null;
  sourceFiles: Array<{ path: string; sha256: string }>;
  sourcePackageSha256: string;
  sourceLockSha256: string;
  sourceWorkspaceSha256: string;
  stagingPackageSha256: string;
  stagingLockSha256: string;
  stagingWorkspaceSha256: string;
  lockValidation: {
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
  };
  tui: {
    name: '@revisium/revo-tui';
    version: string;
    tarballSha256: string;
    integrity: string;
    url: string;
  };
  override: { dependency: '@revisium/revo-tui'; mode: 'exact-https-tarball' };
}

export function verifyStagingReceipt(options: {
  root: string;
  tarballPath: string;
}): Promise<PreparationReceiptInput>;

export function verifyHandoffReceipt(options: {
  root: string;
  bundleRoot: string;
  tarballPath: string;
}): Promise<PreparationReceiptInput>;
