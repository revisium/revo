import { timingSafeEqual } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { isAbsolute, join } from 'node:path';

import { Injectable } from '@nestjs/common';

import {
  DEFAULT_CONTROL_LIMITS,
  type ControlLimits,
  type ControlRecord,
  type ControlStopResult,
  type HeldControlEndpoint,
  type ListenControlEndpointRequest,
} from './control-endpoint.types.js';
import {
  ControlTransportError,
  parseControlRequest,
  parseControlRecord,
  validEndpointPath,
  validateLimits,
} from './control-protocol.js';

@Injectable()
export class ControlEndpointService {
  async listen(request: ListenControlEndpointRequest): Promise<HeldControlEndpoint> {
    const limits = request.limits ?? DEFAULT_CONTROL_LIMITS;
    validateLimits(limits);
    const record = this.record(request);
    await ensurePrivateDirectory(request.runtimeDir);
    const server = createServer();
    const sockets = new Set<Socket>();
    const stop = stopOutcome();
    let stopAccepted = false;
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      void this.serve(socket, record, limits, () => {
        if (stopAccepted) {
          return undefined;
        }
        stopAccepted = true;
        return async () => {
          try {
            await request.onStop();
            stop.resolve({ kind: 'completed' });
          } catch {
            stop.resolve({
              kind: 'failed',
              error: { code: 'CONTROL_STOP_FAILED', message: 'Control stop callback failed' },
            });
          }
        };
      });
    });
    await openServer(server, record.endpoint);
    let closePromise: Promise<void> | undefined;
    return {
      endpoint: record.endpoint,
      stopResult: stop.promise,
      close: () =>
        (closePromise ??= closeEndpoint(server, sockets).then(() => {
          if (!stopAccepted) {
            stop.resolve({ kind: 'not-requested' });
          }
        })),
    };
  }

  private record(request: ListenControlEndpointRequest): ControlRecord {
    const endpoint = join(request.runtimeDir, `c-${request.instanceId}.sock`);
    validateEndpointPath(endpoint);
    const record = {
      schemaVersion: 1 as const,
      instanceId: request.instanceId,
      token: request.token,
      endpoint,
      ...request.identity,
    };
    if (!parseControlRecord(record)) {
      throw new ControlTransportError('Invalid control record');
    }
    return record;
  }

  private async serve(
    socket: Socket,
    record: ControlRecord,
    limits: ControlLimits,
    acceptStop: () => (() => Promise<void>) | undefined,
  ): Promise<void> {
    const deadline = Date.now() + limits.timeoutMs;
    try {
      const request = parseControlRequest(JSON.parse(await readFrame(socket, limits, deadline)));
      if (!request || !authorized(request.instanceId, request.token, record)) {
        await writeFrame(
          socket,
          { schemaVersion: 1, ok: false, code: 'unauthorized' },
          limits,
          deadline,
        );
        return;
      }
      if (request.action === 'probe') {
        const { token: _token, endpoint: _endpoint, ...facts } = record;
        await writeFrame(socket, { schemaVersion: 1, ok: true, facts }, limits, deadline);
        return;
      }
      const runStop = acceptStop();
      try {
        await writeFrame(socket, { schemaVersion: 1, ok: true, accepted: true }, limits, deadline);
      } finally {
        await runStop?.();
      }
    } catch {
      socket.destroy();
    }
  }
}

function authorized(instanceId: string, token: string, record: ControlRecord): boolean {
  const supplied = Buffer.from(token);
  const expected = Buffer.from(record.token);
  return (
    instanceId === record.instanceId &&
    supplied.length === expected.length &&
    timingSafeEqual(supplied, expected)
  );
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory) || directory.includes('\0')) {
    throw new ControlTransportError('Invalid runtime directory');
  }
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      throw new ControlTransportError();
    }
  }
  const state = await lstat(directory).catch(() => undefined);
  if (!state?.isDirectory() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) {
    throw new ControlTransportError('Runtime directory is not private');
  }
}

function validateEndpointPath(endpoint: string): void {
  if (!validEndpointPath(endpoint)) {
    throw new ControlTransportError('Invalid control endpoint path');
  }
}

function readFrame(socket: Socket, limits: ControlLimits, deadline: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (error?: Error, frame?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) {
        reject(error);
      } else {
        resolve(frame ?? '');
      }
    };
    const onData = (chunk: Buffer) => {
      if (data.length + chunk.length > limits.maxFrameBytes) {
        finish(new ControlTransportError());
        return;
      }
      data = Buffer.concat([data, chunk], data.length + chunk.length);
      const newline = data.indexOf(10);
      if (newline >= 0) {
        if (newline !== data.length - 1) {
          finish(new ControlTransportError());
          return;
        }
        finish(undefined, data.subarray(0, newline).toString('utf8'));
      }
    };
    const onEnd = () => finish(new ControlTransportError());
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new ControlTransportError());
    timer = setTimeout(() => finish(new ControlTransportError()), remaining(deadline));
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function writeFrame(
  socket: Socket,
  value: unknown,
  limits: ControlLimits,
  deadline: number,
): Promise<void> {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > limits.maxFrameBytes) {
    return Promise.reject(new ControlTransportError());
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => (socket.destroy(), finish()), remaining(deadline));
    socket.once('error', finish);
    socket.once('close', () => socket.off('error', finish));
    socket.end(frame, finish);
  });
}

function openServer(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', () => reject(new ControlTransportError()));
    server.listen(endpoint, () => (server.removeAllListeners('error'), resolve()));
  });
}

async function closeEndpoint(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const remaining = (deadline: number) => Math.max(1, deadline - Date.now());

function stopOutcome() {
  let resolve!: (value: ControlStopResult) => void;
  const promise = new Promise<ControlStopResult>((settle) => (resolve = settle));
  return { promise, resolve };
}
const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
