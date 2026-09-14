import { timingSafeEqual } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { isAbsolute, join } from 'node:path';

import { Injectable } from '@nestjs/common';

import {
  DEFAULT_CONTROL_LIMITS,
  type ControlLimits,
  type ControlRecord,
  type ControlServerStatus,
  type ControlStopCompletion,
  type ControlStopDeliveryResult,
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
    const delivery = deferred<ControlStopDeliveryResult>();
    let phase: 'accepting' | 'stopping' | 'terminal' = 'accepting';
    let stopAccepted = false;
    let responder: Socket | undefined;
    let closeRequested = false;
    let drainPromise: Promise<void> | undefined;
    const drain = () =>
      (drainPromise ??= closeEndpoint(server, sockets, responder).then(() => {
        if (!stopAccepted) {
          stop.resolve({ kind: 'not-requested' });
        }
      }));
    server.on('connection', (socket) => {
      if (phase !== 'accepting') {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      void this.serve(
        socket,
        record,
        limits,
        request.onStatus,
        () => {
          if (phase !== 'accepting') {
            return undefined;
          }
          phase = 'stopping';
          stopAccepted = true;
          responder = socket;
          for (const other of sockets) {
            if (other !== responder) {
              other.destroy();
            }
          }
          return async (): Promise<ControlStopCompletion> => {
            let completion: ControlStopCompletion;
            try {
              completion = (await request.onStop()) ?? { kind: 'completed' };
            } catch {
              completion = { kind: 'failed', ownership: 'unconfirmed' };
            }
            return completion;
          };
        },
        () => {
          responder = undefined;
        },
        async (completion) => {
          responder = undefined;
          if (
            completion.kind === 'failed' &&
            completion.ownership === 'retained' &&
            !closeRequested
          ) {
            phase = 'accepting';
            return;
          }
          phase = 'terminal';
          await drain();
        },
        (completion, sent) => {
          delivery.resolve({ kind: sent ? 'sent' : 'failed' });
          stop.resolve(
            completion.kind === 'completed'
              ? { kind: 'completed' }
              : {
                  kind: 'failed',
                  error: { code: 'CONTROL_STOP_FAILED', message: 'Control stop callback failed' },
                },
          );
        },
      );
    });
    await openServer(server, record.endpoint);
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closeRequested = true;
      if (phase === 'stopping') {
        for (const socket of sockets) {
          if (socket !== responder) {
            socket.destroy();
          }
        }
        return Promise.resolve();
      }
      phase = 'terminal';
      closePromise ??= drain();
      return closePromise;
    };
    return {
      endpoint: record.endpoint,
      stopResult: stop.promise,
      stopDelivery: delivery.promise,
      close,
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
    onStatus: (() => ControlServerStatus | Promise<ControlServerStatus>) | undefined,
    acceptStop: () => (() => Promise<ControlStopCompletion>) | undefined,
    releaseResponder: () => void,
    completeStop: (completion: ControlStopCompletion) => Promise<void>,
    observeStop: (completion: ControlStopCompletion, sent: boolean) => void,
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
      if (request.action === 'status') {
        const status = (await onStatus?.()) ?? { phase: 'unknown' as const };
        await writeFrame(socket, { schemaVersion: 1, ok: true, status }, limits, deadline);
        return;
      }
      const waitForCompletion = request.action === 'stop-and-wait';
      const runStop = acceptStop();
      if (!runStop) {
        socket.destroy();
        return;
      }
      let acceptedSent = false;
      try {
        await writeFrame(
          socket,
          { schemaVersion: 1, ok: true, accepted: true },
          limits,
          deadline,
          !waitForCompletion,
        );
        acceptedSent = true;
      } catch {
        // Acceptance delivery is not a cancellation boundary for cleanup.
      }
      if (!waitForCompletion) {
        releaseResponder();
      }
      const completion = await runStop();
      if (!waitForCompletion) {
        try {
          await completeStop(completion);
        } finally {
          observeStop(completion, acceptedSent);
        }
        return;
      }
      const response =
        completion.kind === 'completed'
          ? { schemaVersion: 1, ok: true, completed: true }
          : {
              schemaVersion: 1,
              ok: false,
              completed: true,
              code: 'CONTROL_STOP_FAILED',
              message: 'Control stop callback failed',
              ownership: completion.ownership,
            };
      let sent = false;
      try {
        await writeFrame(socket, response, limits, Date.now() + limits.timeoutMs);
        sent = true;
      } catch {
        socket.destroy();
      } finally {
        try {
          await completeStop(completion);
        } catch {
          sent = false;
        }
        observeStop(completion, sent);
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
  end = true,
): Promise<void> {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > limits.maxFrameBytes) {
    return Promise.reject(new ControlTransportError());
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
        reject(new ControlTransportError());
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new ControlTransportError());
    }, remaining(deadline));
    socket.once('error', finish);
    socket.once('close', () => {
      socket.off('error', finish);
      if (!socket.writableFinished) {
        finish(new ControlTransportError());
      }
    });
    if (end) {
      socket.end(frame, finish);
    } else {
      socket.write(frame, (error) => finish(error ?? undefined));
    }
  });
}

function openServer(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', () => reject(new ControlTransportError()));
    server.listen(endpoint, () => {
      server.removeAllListeners('error');
      resolve();
    });
  });
}

async function closeEndpoint(
  server: Server,
  sockets: Set<Socket>,
  preserved?: Socket,
): Promise<void> {
  for (const socket of sockets) {
    if (socket !== preserved) {
      socket.destroy();
    }
  }
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  preserved?.destroy();
  await closed;
}

const remaining = (deadline: number) => Math.max(1, deadline - Date.now());

function stopOutcome() {
  let resolve!: (value: ControlStopResult) => void;
  const promise = new Promise<ControlStopResult>((settle) => (resolve = settle));
  return { promise, resolve };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}
const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
