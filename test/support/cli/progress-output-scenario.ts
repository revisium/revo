import { Writable } from 'node:stream';

import { OutputService } from '../../../src/cli/output.service.js';
import { ProgressOperation } from '../../../src/progress/index.js';

export class ProgressOutputScenario {
  readonly lines: string[] = [];
  private callback: ((error?: Error | null) => void) | undefined;
  private readonly stream = new Writable({
    highWaterMark: 1,
    write: (chunk: Buffer, _encoding, callback) => {
      this.lines.push(chunk.toString());
      this.callback = callback;
    },
  });
  readonly output = new OutputService().progress(this.stream);
  private readonly operation = new ProgressOperation({
    operationId: 'a'.repeat(32),
    now: () => 0,
  });

  write() {
    const event = this.operation.progress('server-start');
    if (!event) {
      throw new Error('fixture operation closed');
    }
    return this.output.sink(event);
  }

  drain() {
    this.callback?.();
  }

  fail() {
    this.callback?.(Object.assign(new Error('private pipe details'), { code: 'EPIPE' }));
  }

  listeners() {
    return {
      error: this.stream.listenerCount('error'),
      drain: this.stream.listenerCount('drain'),
    };
  }

  close() {
    this.output.close();
  }

  destroy(): Promise<void> {
    if (this.stream.closed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.stream.once('close', resolve);
      if (!this.stream.destroyed) {
        this.stream.destroy();
      }
    });
  }
}
