export type ConfigurationErrorCode = 'revo.configuration.file' | 'revo.configuration.invalid';

export class ConfigurationError extends Error {
  readonly code: ConfigurationErrorCode;
  readonly exitCode: 1 | 2;
  readonly field: string;
  readonly source: string;

  constructor(input: {
    code: ConfigurationErrorCode;
    exitCode: 1 | 2;
    field: string;
    message: string;
    source: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'ConfigurationError';
    this.code = input.code;
    this.exitCode = input.exitCode;
    this.field = input.field;
    this.source = input.source;
  }
}

export function invalidConfiguration(field: string, source: string, reason: string): never {
  throw new ConfigurationError({
    code: 'revo.configuration.invalid',
    exitCode: 2,
    field,
    message: `Invalid configuration field ${field} from ${source}: ${reason}`,
    source,
  });
}
