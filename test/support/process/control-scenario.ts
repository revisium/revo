import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ControlClientService } from '../../../src/processes/control-client.service.js';
import { ControlEndpointService } from '../../../src/processes/control-endpoint.service.js';
import type {
  ControlRecord,
  HeldControlEndpoint,
} from '../../../src/processes/control-endpoint.types.js';
import { ProcessIdentityService } from '../../../src/processes/process-identity.service.js';

const INSTANCE = '0123456789abcdef0123456789abcdef';
const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const LIMITS = { timeoutMs: 150, maxFrameBytes: 512 };

export class ControlScenario {
  private readonly roots = new Set<string>();
  private readonly endpoints: HeldControlEndpoint[] = [];
  private readonly client = new ControlClientService();

  async starts(onStop: () => void | Promise<void> = () => undefined) {
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
    const accepted = await Promise.all([
      this.client.requestStop(record, LIMITS),
      this.client.requestStop(record, LIMITS),
    ]);
    return { probe, accepted, stops, stopResult: await endpoint.stopResult };
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
