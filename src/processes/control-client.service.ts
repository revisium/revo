import { connect } from 'node:net';

import { Injectable } from '@nestjs/common';

import {
  DEFAULT_CONTROL_LIMITS,
  type ControlLimits,
  type ControlRecord,
  type ControlStopResponse,
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
    let data = Buffer.alloc(0);
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
        const newline = data.indexOf(10);
        if (newline < 0) {
          if (data.length > limits.maxFrameBytes) {
            finish(new ControlTransportError());
          }
          return;
        }
        if (newline + 1 > limits.maxFrameBytes || frames.length === 2) {
          finish(new ControlTransportError());
          return;
        }
        try {
          frames.push(JSON.parse(data.subarray(0, newline).toString('utf8')));
        } catch {
          finish(new ControlTransportError());
          return;
        }
        data = data.subarray(newline + 1);
        if (frames.length === 1) {
          if (!isAccepted(frames[0])) {
            finish(new ControlTransportError());
            return;
          }
          armCompletion();
        }
        if (frames.length === 2) {
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

function requireRecord(value: unknown, limits: ControlLimits): ControlRecord {
  validateLimits(limits);
  const record = parseControlRecord(value);
  if (!record) {
    throw new ControlTransportError('Invalid control record');
  }
  return record;
}

function exchange(record: ControlRecord, action: 'probe' | 'stop', limits: ControlLimits) {
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
