interface CliFailure {
  readonly exitCode: number;
  readonly message?: string;
}

function property(error: unknown, name: string): unknown {
  if (typeof error !== 'object' || error === null || !(name in error)) {
    return undefined;
  }

  return Reflect.get(error, name);
}

export function cliFailure(error: unknown): CliFailure {
  const code = property(error, 'code');
  const reportedExitCode = property(error, 'exitCode');
  if (reportedExitCode === 0) {
    return { exitCode: 0 };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === 'string' && code.startsWith('commander.')) {
    return { exitCode: 2, message };
  }

  return { exitCode: 1, message };
}
