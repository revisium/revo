import { connect, isIP } from 'node:net';

import { Injectable } from '@nestjs/common';

import {
  DEFAULT_CONTROL_LIMITS,
  type ControlLimits,
  type ControlRecord,
  type ControlStopResponse,
  type ControlStatusResponse,
} from './control-endpoint.types.js';
import { ControlTransportError, parseControlRecord, validateLimits } from './control-protocol.js';

@Injectable()
export class ControlClientService {
  async probe(recordValue: unknown, limits: ControlLimits = DEFAULT_CONTROL_LIMITS) {
    const record = requireRecord(recordValue, limits);
    const response = await exchange(record, 'probe', limits);
    if (!isObject(response) || response.ok !== true || response.schemaVersion !== 1) {
      throw new ControlTransportError();
    }
    const expected = { ...record } as Record<string, unknown>;
    delete expected.token;
    delete expected.endpoint;
    if (JSON.stringify(response.facts) !== JSON.stringify(expected)) {
      throw new ControlTransportError();
    }
    return { kind: 'confirmed' as const };
  }

  async requestStop(recordValue: unknown, limits: ControlLimits = DEFAULT_CONTROL_LIMITS) {
    const record = requireRecord(recordValue, limits);
    const response = await exchange(record, 'stop', limits);
    if (
      !isObject(response) ||
      Object.keys(response).length !== 3 ||
      response.schemaVersion !== 1 ||
      response.ok !== true ||
      response.accepted !== true
    ) {
      throw new ControlTransportError();
    }
    return { kind: 'accepted' as const };
  }

  async requestStatus(
    recordValue: unknown,
    limits: ControlLimits = DEFAULT_CONTROL_LIMITS,
  ): Promise<ControlStatusResponse> {
    const record = requireRecord(recordValue, limits);
    const response = await exchange(record, 'status', limits);
    if (
      !isObject(response) ||
      Object.keys(response).length !== 3 ||
      response.schemaVersion !== 1 ||
      response.ok !== true ||
      !isObject(response.status)
    ) {
      throw new ControlTransportError();
    }
    return parseStatus(response.status);
  }

  async requestStopAndWait(
    recordValue: unknown,
    completionTimeoutMs: number,
    limits: ControlLimits = DEFAULT_CONTROL_LIMITS,
  ): Promise<ControlStopResponse> {
    const record = requireRecord(recordValue, limits);
    if (!Number.isSafeInteger(completionTimeoutMs) || completionTimeoutMs < 1) {
      throw new ControlTransportError('Invalid stop completion timeout');
    }
    const [accepted, completed] = await exchangeStop(record, limits, completionTimeoutMs);
    if (!isAccepted(accepted) || !isObject(completed) || completed.completed !== true) {
      throw new ControlTransportError();
    }
    const completion = parseStopCompletion(completed);
    if (completion) {
      return completion;
    }
    throw new ControlTransportError();
  }
}

function parseStopCompletion(value: Record<string, unknown>): ControlStopResponse | undefined {
  if (Object.keys(value).length === 3 && value.schemaVersion === 1 && value.ok === true) {
    return { kind: 'completed' };
  }
  if (
    Object.keys(value).length === 6 &&
    value.schemaVersion === 1 &&
    value.ok === false &&
    value.code === 'CONTROL_STOP_FAILED' &&
    value.message === 'Control stop callback failed' &&
    (value.ownership === 'retained' || value.ownership === 'unconfirmed')
  ) {
    return {
      kind: 'failed',
      ownership: value.ownership,
      error: { code: 'CONTROL_STOP_FAILED', message: 'Control stop callback failed' },
    };
  }
  return undefined;
}

const isAccepted = (response: unknown) =>
  isObject(response) &&
  Object.keys(response).length === 3 &&
  response.schemaVersion === 1 &&
  response.ok === true &&
  response.accepted === true;

function exchangeStop(record: ControlRecord, limits: ControlLimits, completionTimeoutMs: number) {
  return new Promise<[unknown, unknown]>((resolve, reject) => {
    const socket = connect(record.endpoint);
    const frames: unknown[] = [];
    let data: Buffer = Buffer.alloc(0);
    let settled = false;
    let timer = setTimeout(() => finish(new ControlTransportError()), limits.timeoutMs);
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        reject(new ControlTransportError());
      } else {
        resolve([frames[0], frames[1]]);
      }
    };
    const armCompletion = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new ControlTransportError()), completionTimeoutMs);
    };
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({ schemaVersion: 1, instanceId: record.instanceId, token: record.token, action: 'stop-and-wait' })}\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk], data.length + chunk.length);
      for (;;) {
        const frame = nextStopFrame(data, limits.maxFrameBytes);
        if (frame.kind === 'incomplete') {
          return;
        }
        if (frame.kind === 'invalid') {
          finish(new ControlTransportError());
          return;
        }
        data = frame.rest;
        frames.push(frame.value);
        const outcome = stopFrameOutcome(frame.value, frames.length);
        if (outcome === 'invalid' || outcome === 'extra') {
          finish(new ControlTransportError());
          return;
        }
        if (outcome === 'accepted') {
          armCompletion();
        }
        if (outcome === 'completed') {
          if (data.length !== 0) {
            finish(new ControlTransportError());
          } else {
            finish();
          }
          return;
        }
      }
    });
    socket.once('end', () => frames.length === 2 || finish(new ControlTransportError()));
    socket.once('error', () => finish(new ControlTransportError()));
  });
}

type StopFrame =
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'frame'; readonly value: unknown; readonly rest: Buffer };

function nextStopFrame(data: Buffer, maxFrameBytes: number): StopFrame {
  const newline = data.indexOf(10);
  if (newline < 0) {
    return data.length > maxFrameBytes ? { kind: 'invalid' } : { kind: 'incomplete' };
  }
  if (newline + 1 > maxFrameBytes) {
    return { kind: 'invalid' };
  }
  try {
    return {
      kind: 'frame',
      value: JSON.parse(data.subarray(0, newline).toString('utf8')),
      rest: data.subarray(newline + 1),
    };
  } catch {
    return { kind: 'invalid' };
  }
}

function stopFrameOutcome(
  value: unknown,
  count: number,
): 'accepted' | 'completed' | 'invalid' | 'extra' {
  if (count === 1) {
    return isAccepted(value) ? 'accepted' : 'invalid';
  }
  return count === 2 ? 'completed' : 'extra';
}

function requireRecord(value: unknown, limits: ControlLimits): ControlRecord {
  validateLimits(limits);
  const record = parseControlRecord(value);
  if (!record) {
    throw new ControlTransportError('Invalid control record');
  }
  return record;
}

function exchange(
  record: ControlRecord,
  action: 'probe' | 'status' | 'stop',
  limits: ControlLimits,
) {
  return new Promise<unknown>((resolve, reject) => {
    const socket = connect(record.endpoint);
    let data = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        reject(new ControlTransportError());
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(new ControlTransportError()), limits.timeoutMs);
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({ schemaVersion: 1, instanceId: record.instanceId, token: record.token, action })}\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => {
      if (data.length + chunk.length > limits.maxFrameBytes) {
        finish(new ControlTransportError());
        return;
      }
      data = Buffer.concat([data, chunk], data.length + chunk.length);
      const newline = data.indexOf(10);
      if (newline < 0) {
        return;
      }
      if (newline !== data.length - 1) {
        finish(new ControlTransportError());
        return;
      }
      try {
        finish(undefined, JSON.parse(data.subarray(0, newline).toString('utf8')));
      } catch {
        finish(new ControlTransportError());
      }
    });
    socket.once('end', () => finish(new ControlTransportError()));
    socket.once('error', () => finish(new ControlTransportError()));
  });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseStatus(value: Record<string, unknown>): ControlStatusResponse {
  if (value.phase === 'unknown' && exactKeys(value, ['phase'])) {
    return { phase: 'unknown' };
  }
  const operationId = value.operationId;
  if (typeof operationId !== 'string' || !/^[0-9a-f]{32}$/u.test(operationId)) {
    throw new ControlTransportError();
  }
  if (value.phase === 'running') {
    if (!exactKeys(value, ['phase', 'operationId', 'host', 'port', 'publicUrl'])) {
      throw new ControlTransportError();
    }
    const host = localHost(value.host);
    const publicUrl = publicOrigin(value.publicUrl);
    if (
      !host ||
      typeof value.port !== 'number' ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65_535
    ) {
      throw new ControlTransportError();
    }
    return { phase: 'running', operationId, host, port: value.port, publicUrl };
  }
  if (value.phase === 'failed') {
    if (
      !exactKeys(value, ['phase', 'operationId', 'code', 'ownership']) ||
      typeof value.code !== 'string' ||
      !/^[a-z0-9][a-z0-9.-]{0,127}$/u.test(value.code) ||
      (value.ownership !== 'retained' && value.ownership !== 'unconfirmed')
    ) {
      throw new ControlTransportError();
    }
    return { phase: 'failed', operationId, code: value.code, ownership: value.ownership };
  }
  if (
    (value.phase === 'starting' || value.phase === 'stopping' || value.phase === 'stopped') &&
    exactKeys(value, ['phase', 'operationId'])
  ) {
    return { phase: value.phase, operationId };
  }
  throw new ControlTransportError();
}

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function localHost(value: unknown): string | undefined {
  if (value === '0.0.0.0' || value === '::') {
    return '127.0.0.1';
  }
  if (typeof value !== 'string' || value.length > 253 || /[/?#@[\]]/u.test(value)) {
    return undefined;
  }
  if (isIP(value)) {
    return value;
  }
  return value
    .split('.')
    .every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))
    ? value
    : undefined;
}

function publicOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new ControlTransportError();
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new ControlTransportError();
    }
    return url.origin;
  } catch {
    throw new ControlTransportError();
  }
}
