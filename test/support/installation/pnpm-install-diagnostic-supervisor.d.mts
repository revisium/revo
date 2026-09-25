import type {
  DiagnosticLogState,
  DriverEventMessage,
  DriverResultMessage,
  PnpmActivityCount,
  PnpmErrorCount,
} from './pnpm-install-diagnostic-support.mjs';

export interface InstallDiagnosticInput {
  readonly moduleUrl: string;
  readonly nodeExecutable: string;
  readonly pnpmExecutable: string;
  readonly stage: {
    readonly directory: string;
    readonly packageDirectory: string;
    readonly version: string;
  };
}

export interface InstallDiagnosticLimits {
  readonly readyTimeoutMs?: number;
  readonly spawnTimeoutMs?: number;
  readonly snapshotAtMs?: readonly number[];
  readonly abortAtMs?: number;
  readonly teardownMs?: number;
  readonly forceWaitMs?: number;
  readonly driverCloseTimeoutMs?: number;
  readonly maxMessageBytes?: number;
  readonly maxRecords?: number;
  readonly maxLedgerBytes?: number;
}

export interface InstallDiagnosticEvent {
  readonly name: DriverEventMessage['name'];
  readonly atMs: number;
  readonly code?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly errorCode?: string;
}

export type InstallDiagnosticSnapshot = {
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

export type InstallDiagnosticResult = Omit<DriverResultMessage, 'type'>;
export type InstallDiagnosticFallback =
  | 'invalid-input'
  | 'driver-spawn-failed'
  | 'driver-ready-deadline'
  | 'pnpm-spawn-deadline'
  | 'invalid-driver-message'
  | 'driver-report-budget-exceeded'
  | 'duplicate-driver-event'
  | 'driver-event-order-invalid'
  | 'pnpm-spawn-order-invalid'
  | 'spawn-error-order-invalid'
  | 'exit-without-spawn'
  | 'close-without-spawn-or-error'
  | 'unsolicited-abort-ack'
  | 'snapshot-order-invalid'
  | 'result-order-invalid'
  | 'completion-snapshot-missing'
  | 'post-result-message'
  | 'post-completion-message'
  | 'driver-message-processing-failed'
  | 'driver-process-error'
  | 'driver-disconnected-before-result'
  | 'driver-closed-before-result'
  | 'driver-close-after-result-deadline'
  | 'control-channel-unavailable'
  | 'control-send-failed'
  | 'snapshot-send-failed'
  | 'abort-send-failed'
  | 'teardown-deadline'
  | 'bounded-report-overflow'
  | 'terminal-contract-invalid'
  | 'driver-exit-close-mismatch'
  | 'terminal-timeout';

export interface InstallDiagnosticReport {
  readonly schema: 'revo-pnpm-install-diagnostic/v1';
  readonly state: 'terminal';
  readonly durationMs?: number;
  readonly outcome: InstallDiagnosticResult['outcome'];
  readonly result?: InstallDiagnosticResult;
  readonly events?: readonly InstallDiagnosticEvent[];
  readonly snapshots?: readonly InstallDiagnosticSnapshot[];
  readonly pnpmSpawnSeen?: boolean;
  readonly pnpmSpawnErrorSeen?: boolean;
  readonly pnpmExitSeen?: boolean;
  readonly pnpmCloseSeen?: boolean;
  readonly abortRequested?: boolean;
  readonly abortSent?: boolean;
  readonly abortReceived?: boolean;
  readonly driverExitSeen?: boolean;
  readonly driverCloseSeen?: boolean;
  readonly driverExitCode?: number | null;
  readonly driverExitSignal?: NodeJS.Signals | null;
  readonly driverStatusConsistent?: boolean;
  readonly pnpmStatusConsistent?: boolean | null;
  readonly cleanupConfirmed: boolean;
  readonly sandboxStoppedConfirmed: false;
  readonly fallback?: InstallDiagnosticFallback;
}

export interface SuperviseInstallDiagnosticOptions {
  readonly driverPath: string;
  readonly input: InstallDiagnosticInput;
  readonly environment: Readonly<Record<string, string>>;
  readonly limits?: InstallDiagnosticLimits;
}

export const DEFAULT_INSTALL_DIAGNOSTIC_LIMITS: Readonly<{
  readyTimeoutMs: number;
  spawnTimeoutMs: number;
  snapshotAtMs: readonly number[];
  abortAtMs: number;
  teardownMs: number;
  forceWaitMs: number;
  driverCloseTimeoutMs: number;
  maxMessageBytes: number;
  maxRecords: number;
  maxLedgerBytes: number;
}>;

export function superviseInstallDiagnostic(
  options: SuperviseInstallDiagnosticOptions,
): Promise<InstallDiagnosticReport>;
