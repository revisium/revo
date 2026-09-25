export interface SourceInventoryFile {
  path: string;
  sha256: string;
}

export interface SourceSnapshotOptions {
  /** Trusted local POSIX checkout; callers must keep it unchanged during snapshotting. */
  root: string;
  /** Outside root, with an existing trusted parent; no concurrent writers. Failed output is retained. */
  output: string;
  /** Explicit allowlisted relative build inputs; dirty working-tree bytes are copied. */
  files?: readonly string[];
  /** Deterministic filesystem barriers used only by this script's regression tests. */
  testHooks?: SourceSnapshotTestHooks;
}

export interface SourceSnapshotTestHooks {
  afterInventory?: (files: readonly string[]) => void | Promise<void>;
  beforeSourceOpen?: (path: string) => void | Promise<void>;
  beforeSourceRead?: (path: string) => void | Promise<void>;
  beforeOutputCreate?: (path: string) => void | Promise<void>;
  beforeOutputWrite?: (path: string) => void | Promise<void>;
  beforeFinalOutputCheck?: () => void | Promise<void>;
}

export const REQUIRED_SOURCE_FILES: readonly string[];

export function collectSourceFiles(options: {
  root: string;
  inventory?: readonly string[];
}): Promise<string[]>;

export function createSourceSnapshot(
  options: SourceSnapshotOptions,
): Promise<{ files: SourceInventoryFile[] }>;
