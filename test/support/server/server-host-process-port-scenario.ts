import type { MessageOptions, SendHandle } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class FakeHostProcess extends EventEmitter {
  connected = true;
  exitCode: number | undefined = undefined;
  disconnectCalls = 0;
  readonly sendCalls: unknown[] = [];
  sendCallback: ((error: Error | null) => void) | undefined;
  omitSendCallback = false;

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
    this.emit('disconnect');
  }

  send(
    message: unknown,
    sendHandleOrCallback?: SendHandle | ((error: Error | null) => void),
    optionsOrCallback?: MessageOptions | ((error: Error | null) => void),
    callback?: (error: Error | null) => void,
  ): boolean {
    this.sendCalls.push(message);
    const sendCallback =
      typeof sendHandleOrCallback === 'function'
        ? sendHandleOrCallback
        : typeof optionsOrCallback === 'function'
          ? optionsOrCallback
          : callback;
    if (!this.omitSendCallback && sendCallback) {
      this.sendCallback = sendCallback;
    }
    return true;
  }
}

export function fakeHostProcess(): FakeHostProcess {
  return new FakeHostProcess();
}
