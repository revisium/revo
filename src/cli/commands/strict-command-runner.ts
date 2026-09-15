import { CommandRunner } from 'nest-commander';

type CommanderCommand = Parameters<CommandRunner['setCommand']>[0];
export abstract class StrictCommandRunner extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    command.exitOverride().allowExcessArguments(false);
    return super.setCommand(command);
  }
}
