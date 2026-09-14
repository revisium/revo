import type { EventEmitter } from 'node:events';
import process from 'node:process';

import type { ServerHostChildMessage } from './server-host-protocol.js';

export interface ServerHostProcessPort {
  connected(): boolean;
  onDisconnect(listener: () => void): void;
  onMessage(listener: (message: unknown) => void): void;
  onSignal(listener: () => void): void;
  send(message: ServerHostChildMessage, deadline: number): Promise<void>;
  close(deadline: number): Promise<void>;
  setExitCode(exitCode: 0 | 1 | 2): void;
}

type HostProcess = Pick<NodeJS.Process, 'connected' | 'disconnect' | 'exitCode' | 'send'> &
  Pick<EventEmitter, 'off' | 'on' | 'once'>;

const SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;

export class NodeServerHostProcessPort implements ServerHostProcessPort {
  private readonly disconnectListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly signalListeners = new Set<() => void>();
  private disconnected: boolean;
  private signalled = false;
  private closed = false;
  private readonly disconnectedListener = () => {
    this.disconnected = true;
    for (const listener of this.disconnectListeners) {
      listener();
    }
  };
  private readonly signalledListener = () => {
    this.signalled = true;
    for (const listener of this.signalListeners) {
      listener();
    }
  };

  constructor(private readonly hostProcess: HostProcess = process) {
    this.disconnected = !hostProcess.connected;
    hostProcess.once('disconnect', this.disconnectedListener);
    for (const signal of SIGNALS) {
      hostProcess.on(signal, this.signalledListener);
    }
  }

  connected(): boolean {
    return !this.closed && !this.disconnected && this.hostProcess.connected;
  }

  onDisconnect(listener: () => void): void {
    this.disconnectListeners.add(listener);
    if (this.disconnected) {
      listener();
    }
  }

  onMessage(listener: (message: unknown) => void): void {
    this.messageListeners.add(listener);
    this.hostProcess.on('message', listener);
  }

  onSignal(listener: () => void): void {
    this.signalListeners.add(listener);
    if (this.signalled) {
      listener();
    }
  }

  send(message: ServerHostChildMessage, deadline: number): Promise<void> {
    if (Date.now() >= deadline) {
      return Promise.reject(new Error('IPC send deadline exceeded'));
    }
    if (!this.connected() || !this.hostProcess.send) {
      return Promise.reject(new Error('IPC unavailable'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(
        () => finish(new Error('IPC send deadline exceeded')),
        Math.max(0, deadline - Date.now()),
      );
      this.hostProcess.send?.(message, (error) => finish(error));
    });
  }

  async close(deadline: number): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.hostProcess.connected) {
      this.hostProcess.disconnect?.();
    }
    await this.waitForDisconnect(deadline);
    if (this.hostProcess.connected) {
      throw new Error('IPC close deadline exceeded');
    }
    this.hostProcess.off('disconnect', this.disconnectedListener);
    for (const signal of SIGNALS) {
      this.hostProcess.off(signal, this.signalledListener);
    }
    for (const listener of this.messageListeners) {
      this.hostProcess.off('message', listener);
    }
    this.disconnectListeners.clear();
    this.messageListeners.clear();
    this.signalListeners.clear();
  }

  private async waitForDisconnect(deadline: number): Promise<void> {
    if (!this.hostProcess.connected || Date.now() >= deadline) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(5, deadline - Date.now())));
    return this.waitForDisconnect(deadline);
  }

  setExitCode(exitCode: 0 | 1 | 2): void {
    this.hostProcess.exitCode = exitCode;
  }
}
