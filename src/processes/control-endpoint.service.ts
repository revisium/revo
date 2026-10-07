import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';

import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  CONTROL_SOCKET_ROOT,
  controlSocketRoot,
  prepareControlEndpoint,
} from './control-endpoint.directory.js';
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
  validInstanceId,
  validateLimits,
} from './control-protocol.js';

interface ServeOptions {
  readonly limits: ControlLimits;
  readonly onStatus: (() => ControlServerStatus | Promise<ControlServerStatus>) | undefined;
  readonly acceptStop: () => (() => Promise<ControlStopCompletion>) | undefined;
  readonly releaseResponder: () => void;
  readonly completeStop: (completion: ControlStopCompletion) => Promise<void>;
  readonly observeStop: (completion: ControlStopCompletion, sent: boolean) => void;
}

@Injectable()
export class ControlEndpointService {
  constructor(
    @Optional()
    @Inject(CONTROL_SOCKET_ROOT)
    private readonly socketRoot: string = controlSocketRoot(),
  ) {}

  async listen(request: ListenControlEndpointRequest): Promise<HeldControlEndpoint> {
    const limits = request.limits ?? DEFAULT_CONTROL_LIMITS;
    validateLimits(limits);
    validateLocation(request);
    const endpoint = await prepareControlEndpoint(this.socketRoot, {
      runtimeDir: request.runtimeDir,
      instanceId: request.instanceId,
      channel: request.identity.channel,
      canonicalDataDir: request.identity.canonicalDataDir,
    });
    const record = this.record(request, endpoint);
    const server = createServer();
    const session = new ControlEndpointSession(server, request.onStop);
    server.on('connection', (socket) => {
      if (!session.admit(socket)) {
        return;
      }
      void this.serve(socket, record, {
        limits,
        onStatus: request.onStatus,
        acceptStop: () => session.acceptStop(socket),
        releaseResponder: () => session.releaseResponder(),
        completeStop: (completion) => session.completeStop(completion),
        observeStop: (completion, sent) => session.observeStop(completion, sent),
      });
    });
    await openServer(server, record.endpoint);
    return {
      endpoint: record.endpoint,
      stopResult: session.stopResult,
      stopDelivery: session.stopDelivery,
      close: () => session.close(),
    };
  }

  private record(request: ListenControlEndpointRequest, endpoint: string): ControlRecord {
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

  private async serve(socket: Socket, record: ControlRecord, options: ServeOptions): Promise<void> {
    const deadline = Date.now() + options.limits.timeoutMs;
    try {
      const request = parseControlRequest(
        JSON.parse(await readFrame(socket, options.limits, deadline)),
      );
      if (!request || !authorized(request.instanceId, request.token, record)) {
        await writeFrame(
          socket,
          { schemaVersion: 1, ok: false, code: 'unauthorized' },
          options.limits,
          deadline,
        );
        return;
      }
      if (request.action === 'probe') {
        const { token: _token, endpoint: _endpoint, ...facts } = record;
        await writeFrame(socket, { schemaVersion: 1, ok: true, facts }, options.limits, deadline);
        return;
      }
      if (request.action === 'status') {
        const status = (await options.onStatus?.()) ?? { phase: 'unknown' as const };
        await writeFrame(socket, { schemaVersion: 1, ok: true, status }, options.limits, deadline);
        return;
      }
      await serveStop(socket, request.action === 'stop-and-wait', options, deadline);
    } catch {
      socket.destroy();
    }
  }
}

async function serveStop(
  socket: Socket,
  waitForCompletion: boolean,
  options: ServeOptions,
  deadline: number,
): Promise<void> {
  const runStop = options.acceptStop();
  if (!runStop) {
    socket.destroy();
    return;
  }
  let acceptedSent = false;
  try {
    await writeFrame(
      socket,
      { schemaVersion: 1, ok: true, accepted: true },
      options.limits,
      deadline,
      !waitForCompletion,
    );
    acceptedSent = true;
  } catch {
    // Acceptance delivery is not a cancellation boundary for cleanup.
  }
  if (!waitForCompletion) {
    options.releaseResponder();
  }
  const completion = await runStop();
  if (!waitForCompletion) {
    try {
      await options.completeStop(completion);
    } finally {
      options.observeStop(completion, acceptedSent);
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
    await writeFrame(socket, response, options.limits, Date.now() + options.limits.timeoutMs);
    sent = true;
  } catch {
    socket.destroy();
  } finally {
    try {
      await options.completeStop(completion);
    } catch {
      sent = false;
    }
    options.observeStop(completion, sent);
  }
}

class ControlEndpointSession {
  readonly stopResult: Promise<ControlStopResult>;
  readonly stopDelivery: Promise<ControlStopDeliveryResult>;
  private readonly stop = stopOutcome();
  private readonly delivery = deferred<ControlStopDeliveryResult>();
  private readonly sockets = new Set<Socket>();
  private phase: 'accepting' | 'stopping' | 'terminal' = 'accepting';
  private stopAccepted = false;
  private responder: Socket | undefined;
  private closeRequested = false;
  private drainPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly server: Server,
    private readonly onStop: ListenControlEndpointRequest['onStop'],
  ) {
    this.stopResult = this.stop.promise;
    this.stopDelivery = this.delivery.promise;
  }

  admit(socket: Socket): boolean {
    if (this.phase !== 'accepting') {
      socket.destroy();
      return false;
    }
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    return true;
  }

  acceptStop(socket: Socket): (() => Promise<ControlStopCompletion>) | undefined {
    if (this.phase !== 'accepting') {
      return undefined;
    }
    this.phase = 'stopping';
    this.stopAccepted = true;
    this.responder = socket;
    for (const other of this.sockets) {
      if (other !== this.responder) {
        other.destroy();
      }
    }
    return async (): Promise<ControlStopCompletion> => {
      let completion: ControlStopCompletion;
      try {
        completion = (await this.onStop()) ?? { kind: 'completed' };
      } catch {
        completion = { kind: 'failed', ownership: 'unconfirmed' };
      }
      return completion;
    };
  }

  releaseResponder(): void {
    this.responder = undefined;
  }

  async completeStop(completion: ControlStopCompletion): Promise<void> {
    this.responder = undefined;
    if (
      completion.kind === 'failed' &&
      completion.ownership === 'retained' &&
      !this.closeRequested
    ) {
      this.phase = 'accepting';
      return;
    }
    this.phase = 'terminal';
    await this.drain();
  }

  observeStop(completion: ControlStopCompletion, sent: boolean): void {
    this.delivery.resolve({ kind: sent ? 'sent' : 'failed' });
    this.stop.resolve(
      completion.kind === 'completed'
        ? { kind: 'completed' }
        : {
            kind: 'failed',
            error: { code: 'CONTROL_STOP_FAILED', message: 'Control stop callback failed' },
          },
    );
  }

  close(): Promise<void> {
    this.closeRequested = true;
    if (this.phase === 'stopping') {
      for (const socket of this.sockets) {
        if (socket !== this.responder) {
          socket.destroy();
        }
      }
      return Promise.resolve();
    }
    this.phase = 'terminal';
    this.closePromise ??= this.drain();
    return this.closePromise;
  }

  private drain(): Promise<void> {
    return (this.drainPromise ??= closeEndpoint(this.server, this.sockets, this.responder).then(
      () => {
        if (!this.stopAccepted) {
          this.stop.resolve({ kind: 'not-requested' });
        }
      },
    ));
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

function validateLocation(request: ListenControlEndpointRequest): void {
  if (!isAbsolute(request.runtimeDir) || request.runtimeDir.includes('\0')) {
    throw new ControlTransportError('Invalid runtime directory');
  }
  if (!validInstanceId(request.instanceId)) {
    throw new ControlTransportError('Invalid control record');
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
