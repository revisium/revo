import { Help, Option, SubCommand } from 'nest-commander';

import { CliUsageError } from '../cli-error.js';
import type { TuiStorageMigrationFlags } from '../tui-storage-migration.service.js';
import { TuiStorageMigrationService } from '../tui-storage-migration.service.js';
import { StrictCommandRunner } from './strict-command-runner.js';

@SubCommand({
  name: 'migrate',
  description: 'Migrate legacy TUI command storage while old clients are stopped',
})
export class TuiStorageMigrateCommand extends StrictCommandRunner {
  constructor(private readonly migration: TuiStorageMigrationService) {
    super();
  }

  async run(_passedParams: string[], flags: TuiStorageMigrationFlags = {}): Promise<void> {
    const inherited = inheritedConfiguration(this.command);
    await this.migration.migrate({ ...flags, ...inherited });
  }

  @Help('after')
  inheritedOptionsHelp(): string {
    return [
      'Revo configuration options are accepted before or after "storage migrate":',
      '  --channel <channel>  Release channel',
      '  --config <path>      Configuration file path',
      '  --data-dir <path>    Revo product data directory (migration target is <path>/tui)',
      '  --startup-timeout    Not applicable; this command never starts the server',
    ].join('\n');
  }

  @Option({
    flags: '--api-url <url>',
    description: 'Exact GraphQL URL used by the legacy TUI storage',
  })
  apiUrl(value: string, previous?: string): string {
    assertNotRepeated(previous, '--api-url');
    return value;
  }

  @Option({
    flags: '--confirm-offline',
    description: 'Acknowledge old clients are stopped and new launches are blocked',
  })
  confirmOffline(previous?: boolean): boolean {
    if (previous === true) {
      throw new CliUsageError('--confirm-offline may be specified only once.');
    }
    return true;
  }
}

interface CommanderCommandNode {
  readonly parent?: CommanderCommandNode | null;
  name(): string;
  opts(): unknown;
}

function inheritedConfiguration(
  command: CommanderCommandNode,
): Pick<TuiStorageMigrationFlags, 'channel' | 'config' | 'dataDir'> {
  const storage = command.parent;
  const tui = storage?.parent;
  if (storage?.name() !== 'storage' || tui?.name() !== 'tui') {
    throw new CliUsageError('Could not resolve the Revo TUI migration options.');
  }
  const options: unknown = tui.opts();
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new CliUsageError('Revo TUI migration options are invalid.');
  }
  const record = asCommandOptions(options);
  if (record.startupTimeout !== undefined) {
    throw new CliUsageError('--startup-timeout is not applicable to storage migration.');
  }
  for (const name of ['channel', 'config', 'dataDir'] as const) {
    if (record[name] !== undefined && typeof record[name] !== 'string') {
      throw new CliUsageError(`--${optionName(name)} is invalid.`);
    }
  }
  return {
    ...(typeof record.channel === 'string' ? { channel: record.channel } : {}),
    ...(typeof record.config === 'string' ? { config: record.config } : {}),
    ...(typeof record.dataDir === 'string' ? { dataDir: record.dataDir } : {}),
  };
}

function asCommandOptions(value: object): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  return record;
}

function assertNotRepeated(previous: string | undefined, option: string): void {
  if (previous !== undefined) {
    throw new CliUsageError(`${option} may be specified only once.`);
  }
}

function optionName(name: 'channel' | 'config' | 'dataDir'): string {
  return name === 'dataDir' ? 'data-dir' : name;
}
