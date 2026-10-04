import process from 'node:process';

export function ignoreOutputFailures(): void {
  process.stdout.on('error', () => undefined);
  process.stderr.on('error', () => undefined);
}
