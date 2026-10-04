import { ConsoleLogger, type LogLevel } from '@nestjs/common';

import { redactLog } from './log-redaction.js';

export class RevoConsoleLogger extends ConsoleLogger {
  constructor(context?: string) {
    super({ colors: false, ...(context === undefined ? {} : { context }) });
  }

  failure(message: string, cause: unknown): void {
    if (!(cause instanceof Error)) {
      this.error(`${message}: ${String(cause)}`);
      return;
    }
    if (cause.stack) {
      this.error(`${message}: ${cause.message}`, cause.stack);
      return;
    }
    this.error(`${message}: ${cause.message}`);
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
