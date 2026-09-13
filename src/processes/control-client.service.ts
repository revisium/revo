import { connect } from 'node:net';

import { Injectable } from '@nestjs/common';

import {
  DEFAULT_CONTROL_LIMITS,
  type ControlLimits,
  type ControlRecord,
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
