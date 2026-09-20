interface CliFailure {
  readonly exitCode: number;
  readonly message?: string;
}

/** Commander rejections, the server group usage error, and configuration rejections. */
const USAGE_CODE = /^(?:commander\.|revo\.configuration\.|revo\.cli\.usage$)/u;

export class CliUsageError extends Error {
  readonly code = 'revo.cli.usage';

  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export class CliExitCodeError extends Error {
  constructor(readonly exitCode: number) {
    super('CLI command completed with a non-zero exit code.');
    this.name = 'CliExitCodeError';
  }
}

function property(error: unknown, name: string): unknown {
  if (typeof error !== 'object' || error === null || !(name in error)) {
    return undefined;
  }

  return Reflect.get(error, name);
}

export function cliFailure(error: unknown): CliFailure {
  if (error instanceof CliExitCodeError) {
    return { exitCode: error.exitCode };
  }
  const code = property(error, 'code');
  const reportedExitCode = property(error, 'exitCode');
  if (reportedExitCode === 0) {
    return { exitCode: 0 };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === 'string' && USAGE_CODE.test(code)) {
    return { exitCode: 2, message };
  }

  return { exitCode: 1, message };
}
