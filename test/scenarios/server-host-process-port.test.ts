import { describe, expect, it } from 'vitest';

import { NodeServerHostProcessPort } from '../../src/server/server-host-process-port.js';
import { SERVER_HOST_PROTOCOL } from '../../src/server/server-host-protocol.js';
import { fakeHostProcess } from '../support/server/server-host-process-port-scenario.js';

const booted = { protocol: SERVER_HOST_PROTOCOL, type: 'booted' } as const;

describe('Node server host process port', () => {
  it('replays an early disconnect and signal to later listeners', () => {
    const hostProcess = fakeHostProcess();
    const port = new NodeServerHostProcessPort(hostProcess);
    let disconnects = 0;
    let signals = 0;

    hostProcess.disconnect();
    hostProcess.emit('SIGTERM');

    expect(port.connected()).toBe(false);
    port.onDisconnect(() => {
      disconnects += 1;
    });
    port.onSignal(() => {
      signals += 1;
    });

    expect(disconnects).toBe(1);
    expect(signals).toBe(1);
  });

  it('resolves when the underlying send callback succeeds', async () => {
    const hostProcess = fakeHostProcess();
    const port = new NodeServerHostProcessPort(hostProcess);
    const pending = port.send(booted, Date.now() + 100);

    expect(hostProcess.sendCalls).toEqual([booted]);
    hostProcess.sendCallback?.(null);

    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects when the underlying send callback reports an error', async () => {
    const hostProcess = fakeHostProcess();
    const port = new NodeServerHostProcessPort(hostProcess);
    const pending = port.send(booted, Date.now() + 100);
    const error = new Error('send failed');
    hostProcess.sendCallback?.(error);

    await expect(pending).rejects.toThrow('send failed');
  });

  it('bounds a missing send callback by its deadline', async () => {
    const hostProcess = fakeHostProcess();
    const port = new NodeServerHostProcessPort(hostProcess);
    const pending = port.send(booted, Date.now() + 10);

    await expect(pending).rejects.toThrow('IPC send deadline exceeded');
  });

  it('does not call the underlying send after an expired deadline', async () => {
    const hostProcess = fakeHostProcess();
    const port = new NodeServerHostProcessPort(hostProcess);

    await expect(port.send(booted, Date.now() - 1)).rejects.toThrow('IPC send deadline exceeded');
    expect(hostProcess.sendCalls).toHaveLength(0);
  });

  it('disconnects and waits for a successful close', async () => {
    const hostProcess = fakeHostProcess();
    const port = new NodeServerHostProcessPort(hostProcess);

    await expect(port.close(Date.now() + 100)).resolves.toBeUndefined();
    expect(hostProcess.disconnectCalls).toBe(1);
    expect(hostProcess.connected).toBe(false);
  });

  it('rejects close when the process remains connected through the deadline', async () => {
    const hostProcess = fakeHostProcess();
    hostProcess.disconnect = () => {
      hostProcess.disconnectCalls += 1;
    };
    const port = new NodeServerHostProcessPort(hostProcess);

    await expect(port.close(Date.now() + 10)).rejects.toThrow('IPC close deadline exceeded');
    expect(hostProcess.connected).toBe(true);
  });

  it('removes transport handlers after a successful close', async () => {
    const hostProcess = fakeHostProcess();
    const port = new NodeServerHostProcessPort(hostProcess);
    const messages: unknown[] = [];
    let disconnects = 0;
    let signals = 0;
    port.onMessage((message) => messages.push(message));
    port.onDisconnect(() => {
      disconnects += 1;
    });
    port.onSignal(() => {
      signals += 1;
    });

    await port.close(Date.now() + 100);
    const baseline = { messages: messages.length, disconnects, signals };
    hostProcess.emit('message', booted);
    hostProcess.emit('disconnect');
    hostProcess.emit('SIGTERM');
    hostProcess.emit('SIGHUP');
    hostProcess.emit('SIGINT');

    expect({ messages: messages.length, disconnects, signals }).toEqual(baseline);
  });
});
