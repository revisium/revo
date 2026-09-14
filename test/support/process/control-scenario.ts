import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ControlClientService } from '../../../src/processes/control-client.service.js';
import { ControlEndpointService } from '../../../src/processes/control-endpoint.service.js';
import type {
  ControlRecord,
  HeldControlEndpoint,
  ListenControlEndpointRequest,
} from '../../../src/processes/control-endpoint.types.js';
import { ProcessIdentityService } from '../../../src/processes/process-identity.service.js';

const INSTANCE = '0123456789abcdef0123456789abcdef';
const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const LIMITS = { timeoutMs: 150, maxFrameBytes: 512 };

export class ControlScenario {
  private readonly roots = new Set<string>();
  private readonly endpoints: HeldControlEndpoint[] = [];
  private readonly client = new ControlClientService();

  async starts(onStop: ListenControlEndpointRequest['onStop'] = () => undefined) {
    const runtimeDir = await this.runtimeDir();
    const process = await new ProcessIdentityService().capture(globalThis.process.pid);
    const endpoint = await new ControlEndpointService().listen({
      runtimeDir,
      instanceId: INSTANCE,
      token: TOKEN,
      limits: LIMITS,
      onStop,
      identity: { version: '1.2.3', channel: 'stable', canonicalDataDir: '/data/revo', process },
    });
    this.endpoints.push(endpoint);
    const record: ControlRecord = {
      schemaVersion: 1,
      instanceId: INSTANCE,
      token: TOKEN,
      endpoint: endpoint.endpoint,
      version: '1.2.3',
      channel: 'stable',
      canonicalDataDir: '/data/revo',
      process,
    };
    return { endpoint, record };
  }

  async probesAndStopsOnce() {
    let stops = 0;
    const { endpoint, record } = await this.starts(() => {
      stops += 1;
    });
    const probe = await this.client.probe(record, LIMITS);
    const accepted = [await this.client.requestStop(record, LIMITS)];
    return { probe, accepted, stops, stopResult: await endpoint.stopResult };
  }

  async waitsForCleanupAndRejectsAdmission() {
    let releaseCleanup!: () => void;
    let markEntered!: () => void;
    const cleanup = new Promise<void>((resolve) => (releaseCleanup = resolve));
    const entered = new Promise<void>((resolve) => (markEntered = resolve));
    const { record } = await this.starts(async () => {
      markEntered();
      await cleanup;
    });
    let settled = false;
    const stopping = this.client
      .requestStopAndWait(record, LIMITS.timeoutMs * 4, LIMITS)
      .finally(() => (settled = true));
    await entered;
    const admission = await this.client.probe(record, LIMITS).then(
      () => 'accepted' as const,
      () => 'rejected' as const,
    );
    const beforeCleanup = settled;
    releaseCleanup();
    return { beforeCleanup, admission, completion: await stopping };
  }

  async rearmsOnlyWhenRetentionIsProven() {
    let attempt = 0;
    const retained = await this.starts(() => {
      attempt += 1;
      return attempt === 1
        ? { kind: 'failed' as const, ownership: 'retained' as const }
        : { kind: 'completed' as const };
    });
    const first = await this.client.requestStopAndWait(
      retained.record,
      LIMITS.timeoutMs * 2,
      LIMITS,
    );
    const second = await this.client.requestStopAndWait(
      retained.record,
      LIMITS.timeoutMs * 2,
      LIMITS,
    );
    const unconfirmed = await this.starts(() => ({
      kind: 'failed' as const,
      ownership: 'unconfirmed' as const,
    }));
    const failed = await this.client.requestStopAndWait(
      unconfirmed.record,
      LIMITS.timeoutMs * 2,
      LIMITS,
    );
    const retry = await this.client.requestStop(unconfirmed.record, LIMITS).then(
      () => 'accepted' as const,
      () => 'rejected' as const,
    );
    return { first, second, failed, retry };
  }

  async acceptsCoalescedStopFrames() {
    const process = await new ProcessIdentityService().capture(globalThis.process.pid);
    const runtimeDir = await this.runtimeDir();
    const endpoint = join(runtimeDir, 'coalesced.sock');
    const server = createServer((socket) => {
      socket.once('data', (request: Buffer) => {
        const strict = request.includes(Buffer.from('stop-and-wait'));
        socket.end(
          '{"schemaVersion":1,"ok":true,"accepted":true}\n' +
            (strict ? '{"schemaVersion":1,"ok":true,"completed":true}\n' : ''),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    const record: ControlRecord = {
      schemaVersion: 1,
      instanceId: INSTANCE,
      token: TOKEN,
      endpoint,
      version: '1',
      channel: 'stable',
      canonicalDataDir: '/data',
      process,
    };
    try {
      const legacy = await this.client.requestStop(record, LIMITS);
      const strict = await this.client.requestStopAndWait(record, LIMITS.timeoutMs, LIMITS);
      return { legacy, strict };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async doesNotInferCompletionFromReplyLoss() {
    const process = await new ProcessIdentityService().capture(globalThis.process.pid);
    const runtimeDir = await this.runtimeDir();
    const endpoint = join(runtimeDir, 'reply-lost.sock');
    const server = createServer((socket) => {
      socket.once('data', () => socket.end('{"schemaVersion":1,"ok":true,"accepted":true}\n'));
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    try {
      const record: ControlRecord = {
        schemaVersion: 1,
        instanceId: INSTANCE,
        token: TOKEN,
        endpoint,
        version: '1',
        channel: 'stable',
        canonicalDataDir: '/data',
        process,
      };
      return await this.client.requestStopAndWait(record, LIMITS.timeoutMs, LIMITS).then(
        () => 'completed' as const,
        () => 'unconfirmed' as const,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async rejectsAuthentication() {
    const { record } = await this.starts();
    const wrongToken = { ...record, token: `f${record.token.slice(1)}` };
    const wrongInstance = { ...record, instanceId: `f${record.instanceId.slice(1)}` };
    return Promise.allSettled([
      this.client.probe(wrongToken, LIMITS),
      this.client.probe(wrongInstance, LIMITS),
    ]);
  }

  async observesCallbackFailureAndSelfClose() {
    const failed = await this.starts(() => {
      throw new Error('secret callback');
    });
    await this.client.requestStop(failed.record, LIMITS);
    const failedResult = await failed.endpoint.stopResult;
    let self: HeldControlEndpoint | undefined;
    const closing = await this.starts(async () => self?.close());
    self = closing.endpoint;
    await this.client.requestStop(closing.record, LIMITS);
    return { failedResult, selfClose: await closing.endpoint.stopResult };
  }

  async closeWithIdlePartialConnection() {
    const { endpoint } = await this.starts();
    const socket = connect(endpoint.endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write('{"schemaVersion":1');
    await endpoint.close();
    return endpoint.stopResult;
  }

  async rejectsBadFrames() {
    const { endpoint } = await this.starts();
    const frames = ['{bad}\n', `${'x'.repeat(513)}\n`, '{"schemaVersion":1'];
    return Promise.all(
      frames.map((frame) => rawExchange(endpoint.endpoint, frame, LIMITS.timeoutMs)),
    );
  }

  async rejectsMalformedServerResponses() {
    const process = await new ProcessIdentityService().capture(globalThis.process.pid);
    return Promise.all(
      ['{bad}\n', `${'x'.repeat(513)}\n`, ''].map(async (response) => {
        const runtimeDir = await this.runtimeDir();
        const endpoint = join(runtimeDir, 'fake.sock');
        const sockets = new Set<import('node:net').Socket>();
        const server = createServer((socket) => {
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
          socket.end(response);
        });
        await new Promise<void>((resolve) => server.listen(endpoint, resolve));
        const record = {
          schemaVersion: 1 as const,
          instanceId: INSTANCE,
          token: TOKEN,
          endpoint,
          version: '1',
          channel: 'stable',
          canonicalDataDir: '/data',
          process,
        };
        const result = await Promise.allSettled([this.client.probe(record, LIMITS)]);
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return result[0];
      }),
    );
  }

  async validatesPathBeforeListening() {
    const process = await new ProcessIdentityService().capture(globalThis.process.pid);
    const service = new ControlEndpointService();
    const request = (runtimeDir: string) =>
      service.listen({
        runtimeDir,
        instanceId: INSTANCE,
        token: TOKEN,
        identity: { version: '1', channel: 'stable', canonicalDataDir: '/data', process },
        onStop: () => undefined,
      });
    return Promise.allSettled([request('/tmp/revo\0bad'), request(`/tmp/${'é'.repeat(60)}`)]);
  }

  async acceptsNativePathBoundaryAndPrivateDirectory() {
    const process = await new ProcessIdentityService().capture(globalThis.process.pid);
    const limit = globalThis.process.platform === 'darwin' ? 103 : 107;
    const suffixBytes = Buffer.byteLength(`/c-${INSTANCE}.sock`);
    const ownedRoot = await this.runtimeDir();
    const runtimeDir = join(
      ownedRoot,
      'r'.repeat(limit - suffixBytes - Buffer.byteLength(ownedRoot) - 1),
    );
    await mkdir(runtimeDir, { mode: 0o700 });
    const endpoint = await new ControlEndpointService().listen({
      runtimeDir,
      instanceId: INSTANCE,
      token: TOKEN,
      onStop: () => undefined,
      identity: { version: '1', channel: 'stable', canonicalDataDir: '/data', process },
    });
    this.endpoints.push(endpoint);
    return {
      bytes: Buffer.byteLength(endpoint.endpoint),
      mode: (await stat(runtimeDir)).mode & 0o777,
    };
  }

  async rejectsPublicRuntimeDirectory() {
    const runtimeDir = await this.runtimeDir();
    await chmod(runtimeDir, 0o755);
    const process = await new ProcessIdentityService().capture(globalThis.process.pid);
    return new ControlEndpointService().listen({
      runtimeDir,
      instanceId: INSTANCE,
      token: TOKEN,
      onStop: () => undefined,
      identity: { version: '1', channel: 'stable', canonicalDataDir: '/data', process },
    });
  }

  async disconnectsAfterAcceptedStop() {
    let stops = 0;
    const { endpoint, record } = await this.starts(() => {
      stops += 1;
    });
    const socket = connect(endpoint.endpoint, () => {
      socket.end(
        `${JSON.stringify({ schemaVersion: 1, instanceId: record.instanceId, token: record.token, action: 'stop' })}\n`,
      );
      socket.destroy();
    });
    await endpoint.stopResult;
    return stops;
  }

  async observesFailedFinalReplyAfterCleanup() {
    let cleaned = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => (releaseCleanup = resolve));
    const { endpoint, record } = await this.starts(async () => {
      await cleanup;
      cleaned = true;
    });
    const socket = connect(endpoint.endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(
      `${JSON.stringify({ schemaVersion: 1, instanceId: record.instanceId, token: record.token, action: 'stop-and-wait' })}\n`,
    );
    await new Promise<void>((resolve) => socket.once('data', () => resolve()));
    try {
      await observePeerEnd(socket, LIMITS.timeoutMs);
    } finally {
      releaseCleanup();
      socket.destroy();
    }
    return {
      cleanup: await endpoint.stopResult,
      delivery: await endpoint.stopDelivery,
      cleaned,
    };
  }

  async closesBeforeStop() {
    const { endpoint } = await this.starts();
    const first = endpoint.close();
    const second = endpoint.close();
    await Promise.all([first, second]);
    return endpoint.stopResult;
  }

  async preservesSuccessorAtSamePath() {
    const { endpoint } = await this.starts();
    const path = endpoint.endpoint;
    await endpoint.close();
    const successor = createServer((socket) => socket.end('successor'));
    await new Promise<void>((resolve) => successor.listen(path, resolve));
    await endpoint.close();
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(path);
      socket.setEncoding('utf8');
      socket.once('data', resolve);
      socket.once('error', reject);
    });
    await new Promise<void>((resolve) => successor.close(() => resolve()));
    return response;
  }

  async cleanup() {
    await Promise.allSettled(this.endpoints.map((endpoint) => endpoint.close()));
    await Promise.all([...this.roots].map((root) => rm(root, { recursive: true, force: true })));
  }
  private async runtimeDir() {
    const root = await mkdtemp(join(tmpdir(), 'r4-'));
    this.roots.add(root);
    return root;
  }
}

function rawExchange(endpoint: string, frame: string, timeoutMs: number) {
  return new Promise<'closed'>((resolve, reject) => {
    const socket = connect(endpoint, () => socket.write(frame));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Server did not close the rejected frame'));
    }, timeoutMs * 2);
    socket.once('close', () => (clearTimeout(timer), resolve('closed')));
  });
}

function observePeerEnd(socket: import('node:net').Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error('Server did not observe the client FIN')),
      timeoutMs,
    );
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off('end', onEnd);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onEnd = () => finish();
    const onClose = () => finish(new Error('Control peer closed before acknowledging FIN'));
    const onError = (error: Error) => finish(error);
    socket.once('end', onEnd);
    socket.once('close', onClose);
    socket.once('error', onError);
    socket.end();
  });
}
