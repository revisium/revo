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

/** One command's JSONL output lifetime; async stream mechanics stay outside the renderer. */
export class JsonlProgressOutput {
  private failed = false;
  private closed = false;
  private lateErrorGuard = false;
  private text = '';
  private pending: (() => void) | undefined;
  private readonly renderer = new ProgressRenderer({
    format: 'jsonl',
    isTty: false,
    stdout: (text) => {
      this.text = text;
    },
    stderr: () => undefined,
  });
  private readonly onError = (): void => {
    this.failed = true;
    this.pending?.();
    this.lateErrorGuard = false;
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
    this.assertHealthy();
    this.text = '';
    this.renderer.render(event);
    if (this.text) {
      await this.write(this.text);
    }
  };

  assertHealthy(): void {
    if (this.failed || this.closed) {
      throw new StartProgressOutputError();
    }
  }

  close(): void {
    this.closed = true;
    this.pending?.();
    this.renderer.finish();
    if (!this.lateErrorGuard) {
      this.removeStreamListeners();
    }
  }

  private write(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let callbackDone = false;
      let drained = false;
      let returned = false;
      let settled = false;
      const finish = (failure = false) => {
        if (settled || (!failure && (!returned || !callbackDone || !drained))) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.stdout.off('drain', onDrain);
        this.pending = undefined;
        if (failure) {
          this.failed = true;
          this.lateErrorGuard = true;
          reject(new StartProgressOutputError());
        } else {
          resolve();
        }
      };
      const onDrain = () => {
        drained = true;
        finish();
      };
      // Shorter than the observer's sink budget, so timeout also removes stream listeners.
      const timer = setTimeout(() => finish(true), 200);
      this.pending = () => finish(true);
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

  private removeStreamListeners(): void {
    this.stdout.off('error', this.onError);
    this.stdout.off('close', this.onClose);
  }
}
