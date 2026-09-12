export interface FoundationCliOutput {
  error(message: string): void;
  log(message: string): void;
}

export function runFoundationCli(
  args: readonly string[],
  version: string,
  output: FoundationCliOutput,
): number {
  if (args.length === 1 && args[0] === '--version') {
    output.log(version);
    return 0;
  }

  output.error(
    'This placeholder Revo adapter only supports --version. Product commands require revo-cli integration.',
  );
  return 1;
}
