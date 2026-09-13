export type ManagedProcessErrorCode =
  | 'revo.process.cancelled'
  | 'revo.process.invalid'
  | 'revo.process.spawn'
  | 'revo.process.stop'
  | 'revo.process.stop-timeout';

export class ManagedProcessError extends Error {
  readonly code: ManagedProcessErrorCode;

  constructor(code: ManagedProcessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ManagedProcessError';
    this.code = code;
  }
}
