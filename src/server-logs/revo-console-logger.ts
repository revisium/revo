import { ConsoleLogger, type LogLevel } from '@nestjs/common';

import { redactLog } from './log-redaction.js';

/**
 * Plain-text Nest logging for the server log: no terminal colors, and database credentials are
 * redacted from every message and stack trace before they are written.
 */
export class RevoConsoleLogger extends ConsoleLogger {
  constructor(context?: string) {
    super({ colors: false, ...(context === undefined ? {} : { context }) });
  }

  /** Logs why an operation failed, with the cause's own message and stack when it has them. */
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
