export type InitialDiagnosticCapture =
  | { readonly status: 'complete'; readonly text: string }
  | { readonly status: 'incomplete' | 'missing' | 'unsafe' | 'invalid-utf8' };

export const INITIAL_DIAGNOSTIC_OMITTED = '[diagnostic omitted]';
export const INITIAL_INSTALL_FAILURE_PREFIX = 'REVO_INITIAL_INSTALL_FAILURE ';

export type InitialInstallFailureTestCase =
  | 'real-stable-activation-mode'
  | 'real-alpha-activation-mode'
  | 'real-activation-refuses-during-startup';

export type InitialDiagnosticLogName =
  | 'install-session.log'
  | 'server-start.log'
  | 'activation-result.log';

export type InitialDiagnosticLogStatus =
  | 'captured'
  | 'missing'
  | 'ambiguous'
  | 'unsafe'
  | 'incomplete'
  | 'invalid-utf8'
  | 'io-error'
  | 'too-large';

export type InitialInstallDiagnosticsReason =
  | 'none'
  | 'unsafe-fixture-root'
  | 'channel-outside-fixture'
  | 'channel-unavailable'
  | 'attempts-unavailable'
  | 'attempts-ambiguous'
  | 'attempt-unavailable'
  | 'scratch-unavailable'
  | 'activation-request-ambiguous'
  | 'activation-request-unavailable'
  | 'directory-identity-changed'
  | 'collector-error'
  | 'output-limit';

export interface InitialDiagnosticLogRecord {
  readonly status: InitialDiagnosticLogStatus;
  readonly sizeBytes: number | null;
  readonly diagnostic: string;
}

export interface InitialInstallDiagnostics {
  readonly status: 'complete' | 'incomplete';
  readonly reason: InitialInstallDiagnosticsReason;
  readonly logs: Readonly<Record<InitialDiagnosticLogName, InitialDiagnosticLogRecord>>;
}

export interface InitialInstallFailureReceiptInput {
  readonly testCase: string;
  readonly platform: string;
  readonly arch: string;
  readonly finishCode: number;
  readonly signal: string | null;
  readonly stdoutDiagnostic: InitialDiagnosticCapture;
  readonly stderrDiagnostic: InitialDiagnosticCapture;
  readonly diagnostics: unknown;
}

const MAX_INPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024;
const MAX_RECEIPT_BYTES = 24 * 1024;
const logNames: readonly InitialDiagnosticLogName[] = [
  'install-session.log',
  'server-start.log',
  'activation-result.log',
];
const logStatuses: readonly InitialDiagnosticLogStatus[] = [
  'captured',
  'missing',
  'ambiguous',
  'unsafe',
  'incomplete',
  'invalid-utf8',
  'io-error',
  'too-large',
];
const logStatusSet: ReadonlySet<string> = new Set(logStatuses);
const diagnosticReasons: readonly InitialInstallDiagnosticsReason[] = [
  'none',
  'unsafe-fixture-root',
  'channel-outside-fixture',
  'channel-unavailable',
  'attempts-unavailable',
  'attempts-ambiguous',
  'attempt-unavailable',
  'scratch-unavailable',
  'activation-request-ambiguous',
  'activation-request-unavailable',
  'directory-identity-changed',
  'collector-error',
  'output-limit',
];
const diagnosticReasonSet: ReadonlySet<string> = new Set(diagnosticReasons);
const knownSignals = new Set([
  'SIGABRT',
  'SIGALRM',
  'SIGBUS',
  'SIGCHLD',
  'SIGCONT',
  'SIGFPE',
  'SIGHUP',
  'SIGILL',
  'SIGINT',
  'SIGKILL',
  'SIGPIPE',
  'SIGQUIT',
  'SIGSEGV',
  'SIGSTOP',
  'SIGTERM',
  'SIGTSTP',
  'SIGTTIN',
  'SIGTTOU',
  'SIGUSR1',
  'SIGUSR2',
]);
// oxlint-disable-next-line no-control-regex -- fail closed on untrusted installer diagnostic controls.
const forbiddenControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const ambiguousWhitespace = /[^\S \r\n]|\p{Cf}/u;
const credentialAssignment =
  /(?<![\p{L}\p{N}_$])(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z_][A-Za-z\d_.-]*))(?=\s*[:=])/giu;
const credentialProtocol =
  /(?:\b(?:bearer|basic)\s+[^\s,;]+|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+@)/iu;
const urlSchemePrefix = /https?:\/\//iu;
const anyUrlSchemePrefix = /[a-z][a-z\d+.-]*:\/\//iu;
const urlPunctuation = /["'`<>\\%]/u;

function isCredentialAssignmentKey(key: string): boolean {
  const normalized = key.replace(/([a-z\d])([A-Z])/gu, '$1_$2').toLowerCase();
  if (normalized === 'pgpassword') {
    return true;
  }
  return /(?:^|[_ .-])(?:authorization|bearer|basic|password|passwd|secret|token|cookie|api[_-]?key|auth[_-]?token)$/u.test(
    normalized,
  );
}

function hasCredentialAssignment(text: string): boolean {
  credentialAssignment.lastIndex = 0;
  for (
    let match = credentialAssignment.exec(text);
    match !== null;
    match = credentialAssignment.exec(text)
  ) {
    const key = match[1] ?? match[2] ?? match[3];
    if (key !== undefined && isCredentialAssignmentKey(key)) {
      return true;
    }
  }
  return false;
}

function redactRoot(text: string, roots: readonly string[]): string {
  let result = text;
  for (const root of [...roots].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(root, '<fixture>');
  }
  return result;
}

function sanitizeUrl(candidate: string): string | undefined {
  if (urlPunctuation.test(candidate)) {
    return undefined;
  }
  const schemeEnd = candidate.indexOf('://');
  const authorityStart = schemeEnd + 3;
  const authorityEndIndex = candidate.slice(authorityStart).search(/[/?#]/u);
  const authorityEnd =
    authorityEndIndex < 0 ? candidate.length : authorityStart + authorityEndIndex;
  const authority = candidate.slice(authorityStart, authorityEnd);
  const at = authority.lastIndexOf('@');
  const host = at < 0 ? authority : authority.slice(at + 1);
  if (!host || host.startsWith('@')) {
    return undefined;
  }
  try {
    const parsed = new URL(`${candidate.slice(0, schemeEnd)}://${host}`);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return `URL origin scheme=${parsed.protocol.slice(0, -1)} host=${parsed.hostname} port=${port}`;
  } catch {
    return undefined;
  }
}

export function sanitizeInitialDiagnostic(
  capture: InitialDiagnosticCapture,
  roots: readonly string[] = [],
): string {
  if (capture.status !== 'complete') {
    return INITIAL_DIAGNOSTIC_OMITTED;
  }
  const raw = capture.text;
  if (
    Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES ||
    forbiddenControls.test(raw) ||
    ambiguousWhitespace.test(raw) ||
    /\r(?!\n)/u.test(raw)
  ) {
    return INITIAL_DIAGNOSTIC_OMITTED;
  }

  let text = raw.replaceAll('\r\n', '\n');
  const scheme = anyUrlSchemePrefix.exec(text);
  if (scheme !== null) {
    const httpScheme = urlSchemePrefix.exec(text);
    if (httpScheme === null || httpScheme.index !== scheme.index) {
      return INITIAL_DIAGNOSTIC_OMITTED;
    }
    if (raw.includes('\n')) {
      return INITIAL_DIAGNOSTIC_OMITTED;
    }
    const index = httpScheme.index;
    const candidate = text.slice(index).replace(/ +$/u, '');
    if (candidate.includes(' ')) {
      return INITIAL_DIAGNOSTIC_OMITTED;
    }
    const replacement = sanitizeUrl(candidate);
    if (replacement === undefined) {
      return INITIAL_DIAGNOSTIC_OMITTED;
    }
    text = `${text.slice(0, index)}${replacement}`;
  }

  if (
    hasCredentialAssignment(text) ||
    credentialProtocol.test(text) ||
    /%[\da-f]{0,2}/iu.test(text) ||
    text.includes('%')
  ) {
    return INITIAL_DIAGNOSTIC_OMITTED;
  }
  text = redactRoot(text, roots);
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) {
    return INITIAL_DIAGNOSTIC_OMITTED;
  }
  return text || INITIAL_DIAGNOSTIC_OMITTED;
}

export function serializeInitialInstallFailureReceipt(
  input: InitialInstallFailureReceiptInput,
): string {
  const testCases = [
    'real-stable-activation-mode',
    'real-alpha-activation-mode',
    'real-activation-refuses-during-startup',
  ];
  if (!testCases.includes(input.testCase)) {
    throw new Error('invalid initial-install test case');
  }
  if (input.platform !== 'linux' && input.platform !== 'darwin' && input.platform !== 'unknown') {
    throw new Error('invalid initial-install platform');
  }
  if (input.arch !== 'x64' && input.arch !== 'arm64' && input.arch !== 'unknown') {
    throw new Error('invalid initial-install architecture');
  }
  if (!Number.isSafeInteger(input.finishCode) || input.finishCode < 0 || input.finishCode > 255) {
    throw new Error('invalid initial-install finish code');
  }

  const diagnostics = sanitizeInitialInstallDiagnostics(input.diagnostics);
  const fields = {
    testCase: input.testCase,
    platform: input.platform,
    arch: input.arch,
    finishCode: input.finishCode,
    signal: input.signal !== null && knownSignals.has(input.signal) ? input.signal : null,
    stdoutDiagnostic: sanitizeInitialDiagnostic(input.stdoutDiagnostic),
    stderrDiagnostic: sanitizeInitialDiagnostic(input.stderrDiagnostic),
    diagnostics,
  };
  const serialize = (value: typeof fields) =>
    `${INITIAL_INSTALL_FAILURE_PREFIX}${JSON.stringify(value)}`;
  let output = serialize(fields);
  if (Buffer.byteLength(`${output}\n`, 'utf8') > MAX_RECEIPT_BYTES) {
    output = serialize({
      ...fields,
      stdoutDiagnostic: INITIAL_DIAGNOSTIC_OMITTED,
      stderrDiagnostic: INITIAL_DIAGNOSTIC_OMITTED,
      diagnostics: omitAllDiagnosticTexts(diagnostics),
    });
  }
  if (Buffer.byteLength(`${output}\n`, 'utf8') > MAX_RECEIPT_BYTES) {
    throw new Error('initial-install receipt exceeds size bound');
  }
  return output;
}

function incompleteLogRecords(): Record<InitialDiagnosticLogName, InitialDiagnosticLogRecord> {
  const record: InitialDiagnosticLogRecord = {
    status: 'incomplete',
    sizeBytes: null,
    diagnostic: INITIAL_DIAGNOSTIC_OMITTED,
  };
  return {
    'install-session.log': record,
    'server-start.log': record,
    'activation-result.log': record,
  };
}

function sanitizeInitialInstallDiagnostics(input: unknown): InitialInstallDiagnostics {
  if (!isRecord(input)) {
    return {
      status: 'incomplete',
      reason: 'collector-error',
      logs: incompleteLogRecords(),
    };
  }
  const candidate = input;
  let status: InitialInstallDiagnostics['status'] =
    candidate.status === 'complete' ? 'complete' : 'incomplete';
  let reason: InitialInstallDiagnosticsReason = isDiagnosticReason(candidate.reason)
    ? candidate.reason
    : 'collector-error';
  if (!isDiagnosticReason(candidate.reason)) {
    status = 'incomplete';
  }
  const sourceLogs = candidate.logs;
  const logs = incompleteLogRecords();
  if (isRecord(sourceLogs)) {
    for (const name of logNames) {
      const item = sourceLogs[name];
      if (!isRecord(item)) {
        status = 'incomplete';
        continue;
      }
      const recordStatus = item.status;
      const sizeBytes = item.sizeBytes;
      const sizeValid =
        recordStatus === 'captured'
          ? typeof sizeBytes === 'number' &&
            Number.isSafeInteger(sizeBytes) &&
            sizeBytes >= 0 &&
            sizeBytes <= MAX_INPUT_BYTES
          : recordStatus === 'too-large'
            ? typeof sizeBytes === 'number' &&
              Number.isSafeInteger(sizeBytes) &&
              sizeBytes > MAX_INPUT_BYTES
            : recordStatus === 'invalid-utf8'
              ? typeof sizeBytes === 'number' &&
                Number.isSafeInteger(sizeBytes) &&
                sizeBytes >= 0 &&
                sizeBytes <= MAX_INPUT_BYTES
              : sizeBytes === null;
      const diagnosticText = item.diagnostic;
      if (
        !isDiagnosticLogStatus(recordStatus) ||
        !sizeValid ||
        typeof diagnosticText !== 'string'
      ) {
        logs[name] = {
          status: 'incomplete',
          sizeBytes: null,
          diagnostic: INITIAL_DIAGNOSTIC_OMITTED,
        };
        status = 'incomplete';
        continue;
      }
      const numericSize = typeof sizeBytes === 'number' ? sizeBytes : null;
      const diagnostic =
        recordStatus === 'captured'
          ? sanitizeInitialDiagnostic({ status: 'complete', text: diagnosticText })
          : INITIAL_DIAGNOSTIC_OMITTED;
      logs[name] = {
        status: recordStatus,
        sizeBytes: numericSize,
        diagnostic,
      };
      if (
        recordStatus === 'ambiguous' ||
        recordStatus === 'unsafe' ||
        recordStatus === 'incomplete' ||
        recordStatus === 'invalid-utf8' ||
        recordStatus === 'io-error' ||
        recordStatus === 'too-large'
      ) {
        status = 'incomplete';
      }
    }
  } else {
    status = 'incomplete';
  }
  if (status === 'incomplete' && reason === 'none') {
    reason = 'collector-error';
  }
  return { status, reason, logs };
}

function omitAllDiagnosticTexts(diagnostics: InitialInstallDiagnostics): InitialInstallDiagnostics {
  const logs = incompleteLogRecords();
  for (const name of logNames) {
    logs[name] = {
      status: diagnostics.logs[name].status,
      sizeBytes: diagnostics.logs[name].sizeBytes,
      diagnostic: INITIAL_DIAGNOSTIC_OMITTED,
    };
  }
  return { status: diagnostics.status, reason: diagnostics.reason, logs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDiagnosticLogStatus(value: unknown): value is InitialDiagnosticLogStatus {
  return typeof value === 'string' && logStatusSet.has(value);
}

function isDiagnosticReason(value: unknown): value is InitialInstallDiagnosticsReason {
  return typeof value === 'string' && diagnosticReasonSet.has(value);
}
