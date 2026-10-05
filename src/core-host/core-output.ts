import type { Readable, Writable } from 'node:stream';

import { redactLog } from '../server-logs/log-redaction.js';

const MAX_PENDING_CHARACTERS = 64 * 1024;

/** Copies Core output by whole lines, so a secret split across pipe chunks is still redacted. */
export function forwardRedacted(source: Readable | undefined, target: Writable): void {
  if (!source) {
    return;
  }
  let pending = '';
  const write = (text: string) => {
    if (!text) {
      return;
    }
    try {
      target.write(redactLog(text));
    } catch {
      // The server log is diagnostics; losing it never changes the Core lifecycle.
    }
  };
  source.setEncoding('utf8');
  source.on('data', (chunk: string) => {
    pending += chunk;
    const complete = pending.lastIndexOf('\n') + 1;
    if (complete > 0) {
      write(pending.slice(0, complete));
      pending = pending.slice(complete);
    }
    if (pending.length > MAX_PENDING_CHARACTERS) {
      write(`${pending}\n`);
      pending = '';
    }
  });
  source.once('end', () => write(pending));
  source.on('error', () => undefined);
}
