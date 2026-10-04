import type { Writable } from 'node:stream';

import { Injectable } from '@nestjs/common';

import { ProgressRenderer, type ProgressEvent } from '../progress/index.js';
import { StartProgressOutputError } from '../server/server-startup-observer.js';

@Injectable()
export class OutputService {
  progress(stdout: Writable = process.stdout): JsonlProgressOutput {
    return new JsonlProgressOutput(stdout);
  }

  write(message: string): void {
    process.stdout.write(this.line(message));
  }

  writeError(message: string): void {
    process.stderr.write(this.line(message));
  }

  private line(message: string): string {
    return message.endsWith('\n') ? message : `${message}\n`;
  }
}

/**
 * One command's JSONL output lifetime. Slow writes stay pending for the observer to skip; only a
 * stream error ends the output, and the error listener outlives close while a write is unsettled.
 */
export class JsonlProgressOutput {
  private broken = false;
  private errorObserved = false;
  private closed = false;
  private text = '';
  private readonly pending = new Set<() => void>();
  private readonly renderer = new ProgressRenderer({
    format: 'jsonl',
    isTty: false,
    stdout: (text) => {
      this.text = text;
    },
    stderr: () => undefined,
  });
  private readonly onError = (): void => {
    this.broken = true;
    this.errorObserved = true;
    this.settlePending();
    this.stdout.off('error', this.onError);
  };
  private readonly onClose = (): void => {
    this.removeStreamListeners();
  };

  constructor(private readonly stdout: Writable) {
    stdout.on('error', this.onError);
    stdout.once('close', this.onClose);
  }

  readonly sink = async (event: ProgressEvent): Promise<void> => {
    if (this.broken || this.closed) {
      throw new StartProgressOutputError();
    }
    this.text = '';
    this.renderer.render(event);
    if (this.text) {
      await this.write(this.text);
    }
  };

  close(): void {
    this.closed = true;
    const lateErrorPossible = this.pending.size > 0 || (this.broken && !this.errorObserved);
    this.settlePending();
    this.renderer.finish();
    if (!lateErrorPossible) {
      this.removeStreamListeners();
    }
  }

  private write(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let callbackDone = false;
      let drained = false;
      let returned = false;
      const finish = (failure = false) => {
        if (!failure && (!returned || !callbackDone || !drained)) {
          return;
        }
        if (!this.pending.delete(fail)) {
          return;
        }
        this.stdout.off('drain', onDrain);
        if (failure) {
          this.broken = true;
          reject(new StartProgressOutputError());
        } else {
          resolve();
        }
      };
      const fail = () => finish(true);
      const onDrain = () => {
        drained = true;
        finish();
      };
      this.pending.add(fail);
      this.stdout.on('drain', onDrain);
      try {
        drained =
          this.stdout.write(text, (error) => {
            callbackDone = true;
            finish(Boolean(error));
          }) || drained;
        returned = true;
        finish();
      } catch {
        finish(true);
      }
    });
  }

  private settlePending(): void {
    // Each settlement removes only itself, which a Set iteration tolerates.
    for (const fail of this.pending) {
      fail();
    }
  }

  private removeStreamListeners(): void {
    this.stdout.off('error', this.onError);
    this.stdout.off('close', this.onClose);
  }
}
