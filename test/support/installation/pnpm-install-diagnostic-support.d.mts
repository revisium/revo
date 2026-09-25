import type { EventEmitter } from 'node:events';
import type { Stats } from 'node:fs';

export const PNPM_DIAGNOSTIC_SNAPSHOTS_MS: readonly number[];
export const PNPM_DIAGNOSTIC_ABORT_MS: number;
export const PNPM_DIAGNOSTIC_MAX_REPORT_BYTES: number;
export const PNPM_DIAGNOSTIC_MAX_ARCHIVE_BYTES: number;
export const PNPM_DIAGNOSTIC_MAX_EXPANDED_BYTES: number;

export type SafePnpmErrorCode =
  | 'EACCES'
  | 'EEXIST'
  | 'EINTR'
  | 'EINVAL'
  | 'EIO'
  | 'EMFILE'
  | 'ENOENT'
  | 'ENOSPC'
  | 'EPERM'
  | 'EPIPE'
  | 'ESRCH'
  | 'ETIMEDOUT'
  | 'ECONNRESET'
  | 'ECONNREFUSED'
  | 'ENOTFOUND'
  | 'UND_ERR_ABORTED'
  | 'other';

export interface ExpectedPnpmInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options?: { readonly cwd?: string };
}

export type ObservedChildEvent =
  | { readonly name: 'spawn'; readonly atMs: number }
  | { readonly name: 'spawn-error'; readonly atMs: number; readonly errorCode: SafePnpmErrorCode }
  | {
      readonly name: 'exit' | 'close';
      readonly atMs: number;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

export interface ObservedChildState {
  readonly errorSeen: boolean;
  readonly exitSeen: boolean;
  readonly closeSeen: boolean;
  readonly spawnSeen: boolean;
  readonly observerIncomplete?: boolean;
}

export interface PnpmActivityCount {
  readonly name: string;
  readonly count: number;
}

export interface PnpmErrorCount {
  readonly code: SafePnpmErrorCode;
  readonly count: number;
}

export type DiagnosticLogState =
  | 'safe'
  | 'missing'
  | 'unavailable'
  | 'not-regular'
  | 'read-failed'
  | 'nofollow-unavailable'
  | 'changed'
  | 'unsafe-path'
  | 'unsafe-root';

interface DriverMessageBase {
  readonly atMs: number;
}

export type DriverEventMessage =
  | ({
      readonly type: 'event';
      readonly name: 'ready' | 'spawn' | 'abort-received' | 'observer-error';
    } & DriverMessageBase)
  | ({
      readonly type: 'event';
      readonly name: 'spawn-error';
      readonly errorCode: SafePnpmErrorCode;
    } & DriverMessageBase)
  | ({
      readonly type: 'event';
      readonly name: 'exit' | 'close';
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    } & DriverMessageBase);

export type DriverSnapshotMessage = {
  readonly type: 'snapshot';
  readonly id: number;
  readonly atMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
} & (
  | { readonly logSafe: false; readonly logState: Exclude<DiagnosticLogState, 'safe'> }
  | {
      readonly logSafe: true;
      readonly logState: 'safe';
      readonly logSize: number;
      readonly tailChanged: boolean;
      readonly activity: readonly PnpmActivityCount[];
      readonly lastActivityMs: number | null;
      readonly errorCodes: readonly PnpmErrorCount[];
      readonly malformedLines: number;
      readonly droppedLines: number;
    }
);

export type DriverResultMessage = {
  readonly type: 'result';
  readonly outcome: 'success' | 'install-error' | 'observer-incomplete' | 'driver-error';
  readonly atMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly observerIncomplete: boolean;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly errorCode?: SafePnpmErrorCode;
};

export type DriverMessage = DriverEventMessage | DriverSnapshotMessage | DriverResultMessage;

export type InstallLogSnapshot =
  | { readonly safe: false; readonly reason: Exclude<DiagnosticLogState, 'safe'> }
  | {
      readonly safe: true;
      readonly size: number;
      readonly tailChanged: boolean;
      readonly tailDigest: string;
    };

export interface PnpmArchiveDescriptor {
  readonly url: string;
  readonly sha256: string;
}

export interface PnpmArchiveResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: AsyncIterable<Uint8Array> | null;
}

export type PnpmArchiveRequest = (
  url: string,
  options: { readonly redirect: 'manual'; readonly signal: AbortSignal },
) => Promise<PnpmArchiveResponse>;

export interface PnpmArchiveDownloadOptions {
  readonly descriptor: PnpmArchiveDescriptor;
  readonly destination: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly request?: PnpmArchiveRequest;
}

export interface PnpmArchiveDownloadResult {
  readonly size: number;
  readonly redirects: number;
  readonly sha256: string;
}

export interface DiagnosticScheduleOptions {
  readonly sendSnapshot: (id: number) => void;
  readonly sendAbort: () => void;
  readonly onFallback: (
    reason: 'snapshot-send-failed' | 'abort-send-failed' | 'teardown-deadline',
  ) => void;
  readonly snapshotAtMs?: readonly number[];
  readonly abortAtMs?: number;
  readonly teardownMs?: number;
  readonly schedule?: (callback: () => void, delay: number) => NodeJS.Timeout;
  readonly cancel?: (timer: NodeJS.Timeout) => void;
}

export interface ArchiveFileSystem {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly open: (
    path: string,
    flags: number,
  ) => Promise<{
    readonly stat: () => Promise<Stats>;
    readonly read: (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => Promise<{
      readonly bytesRead: number;
      readonly buffer: Buffer;
    }>;
    readonly close: () => Promise<void>;
  }>;
}

export interface ReadBoundedArchiveDescriptorOptions {
  readonly archivePath: string;
  readonly expectedSha256: string;
  readonly fileSystem?: ArchiveFileSystem;
  readonly allocate?: (size: number) => Buffer;
}

export interface VerifiedPnpmArchiveOptions {
  readonly archivePath: string;
  readonly destinationRoot: string;
  readonly expectedSha256: string;
  readonly maxExpandedBytes?: number;
}

export interface ProgressObserverSnapshot {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly malformedLines: number;
  readonly droppedLines: number;
  readonly activity: readonly PnpmActivityCount[];
  readonly lastActivityMs: number | null;
  readonly errorCodes: readonly PnpmErrorCount[];
}

export function matchesPnpmInvocation(call: unknown, expected: ExpectedPnpmInvocation): boolean;
export function createObservedSpawn<T extends object>(options: {
  readonly original: (this: unknown, ...args: unknown[]) => T;
  readonly expected: ExpectedPnpmInvocation;
  readonly observeChild?: (
    child: T | undefined,
    event?: { readonly type: 'spawn' | 'spawn-error'; readonly code?: SafePnpmErrorCode },
  ) => void;
}): {
  readonly spawn: (this: unknown, ...args: unknown[]) => T;
  readonly original: (this: unknown, ...args: unknown[]) => T;
  readonly summary: () => {
    readonly calls: number;
    readonly matches: number;
    readonly observerIncomplete: boolean;
  };
};
export function observeSpawnedChild(
  child: (EventEmitter & { readonly stderr?: EventEmitter }) | undefined,
  options?: {
    readonly onEvent?: (event: ObservedChildEvent) => void;
    readonly onStderr?: (chunk: unknown) => void;
    readonly now?: () => number;
  },
): { readonly snapshot: () => ObservedChildState };
export function createBoundedProgressObserver(now?: () => number): {
  readonly feed: (chunk: string | Uint8Array) => void;
  readonly addStderr: (chunk: string | Uint8Array) => void;
  readonly finish: () => void;
  readonly snapshot: () => ProgressObserverSnapshot;
};
export function readInstallLogSnapshot(
  path: string,
  previousTail: string | undefined,
  fixtureRoot: string,
): Promise<InstallLogSnapshot>;
export function downloadPinnedPnpmArchive(
  options: PnpmArchiveDownloadOptions,
): Promise<PnpmArchiveDownloadResult>;
export function boundedDiagnosticReport<T extends Record<string, unknown>>(value: T): T;
export function createDiagnosticSchedule(options: DiagnosticScheduleOptions): {
  readonly start: () => void;
  readonly finish: () => void;
};
export function readBoundedArchiveDescriptor(
  options: ReadBoundedArchiveDescriptorOptions,
): Promise<Buffer>;
export function extractVerifiedPnpmArchive(
  options: VerifiedPnpmArchiveOptions,
): Promise<{ readonly directory: string; readonly executablePath: string }>;
export function isSafeDriverMessage(value: unknown): value is DriverMessage;
