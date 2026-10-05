import { ConsoleLogger, type LogLevel } from '@nestjs/common';

import { redactLog } from './log-redaction.js';

export class RevoConsoleLogger extends ConsoleLogger {
  constructor(context?: string) {
    super({ colors: false, ...(context === undefined ? {} : { context }) });
  }

  failure(message: string, cause: unknown): void {
    const reason = `${message}: ${causeChain(cause)}`;
    if (cause instanceof Error && cause.stack) {
      this.error(reason, cause.stack);
      return;
    }
    this.error(reason);
  }

  protected override formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    return redactLog(
      super.formatMessage(
        logLevel,
        message,
        pidMessage,
        formattedLogLevel,
        contextMessage,
        timestampDiff,
      ),
    );
  }

  protected override printStackTrace(stack: string): void {
    super.printStackTrace(typeof stack === 'string' ? redactLog(stack) : stack);
  }
}

function causeChain(cause: unknown, seen = new Set<Error>()): string {
  if (!(cause instanceof Error)) {
    return String(cause);
  }
  seen.add(cause);
  if (cause.cause === undefined || (cause.cause instanceof Error && seen.has(cause.cause))) {
    return cause.message;
  }
  return `${cause.message}: ${causeChain(cause.cause, seen)}`;
}
