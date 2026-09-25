export function bootstrapAcceptanceTooling(options: {
  repositoryRoot: string;
  runnerTemp: string;
  pnpmPath?: string;
}): Promise<{
  toolingRoot: string;
  moduleLink: string;
  copiedFiles: string[];
}>;
