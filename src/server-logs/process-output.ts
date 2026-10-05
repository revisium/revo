import process from 'node:process';

export function ignoreOutputFailures(): void {
  process.stdout.on('error', () => undefined);
  ignoreDiagnosticOutputFailures();
}

export function ignoreDiagnosticOutputFailures(): void {
  process.stderr.on('error', () => undefined);
}
