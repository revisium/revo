import { chmod, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ControlClientService } from '../../src/processes/control-client.service.js';
import { ControlEndpointService } from '../../src/processes/control-endpoint.service.js';
import type {
  ControlRecord,
  ControlServerStatus,
  HeldControlEndpoint,
} from '../../src/processes/control-endpoint.types.js';
import { ControlTransportError } from '../../src/processes/control-protocol.js';
import { ProcessIdentityService } from '../../src/processes/process-identity.service.js';
import { ServerOwnershipService } from '../../src/processes/server-ownership.service.js';
import { ServerStatusService } from '../../src/server/server-status.service.js';
import { ServerStopService } from '../../src/server/server-stop.service.js';

const roots: string[] = [];
const servers: Server[] = [];
const endpoints: HeldControlEndpoint[] = [];
const limits = { timeoutMs: 500, maxFrameBytes: 16_384 };

afterEach(async () => {
  const closed = await Promise.allSettled([
    ...endpoints.splice(0).map((endpoint) => endpoint.close()),
    ...servers.splice(0).map((server) => closeServer(server)),
  ]);
  const failures = closed.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'status fixture cleanup failed');
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('server status and stop services', () => {
  it('reports missing without creating data or lock paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rs-'));
    roots.push(root);
    const dataDir = join(root, 'missing');
    await expect(new ServerStatusService().read(dataDir)).resolves.toEqual({ kind: 'stopped' });
    await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
    const lease = await new ServerOwnershipService().acquire(dataDir);
    if (lease.kind !== 'held') {
      throw new Error('ownership fixture was unexpectedly busy');
    }
    try {
      await expect(new ServerStatusService().read(dataDir)).resolves.toEqual({ kind: 'unknown' });
    } finally {
      await lease.release();
    }
    await expect(new ServerStatusService().read(dataDir)).resolves.toEqual({ kind: 'stopped' });
  });

  it('authenticates status and probes the effective local listener', async () => {
    const fixture = await controlFixture({
      phase: 'running',
      operationId: 'abcdefabcdefabcdefabcdefabcdefab',
      host: '127.0.0.1',
      port: 1,
      publicUrl: 'http://public.invalid',
    });
    const http = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"data":{"__typename":"Query"}}');
    });
    servers.push(http);
    await listenServer(http);
    const address = http.address();
    if (!address || typeof address === 'string') {
      throw new Error('HTTP fixture did not listen');
    }
    fixture.replaceStatus({
      phase: 'running',
      operationId: 'abcdefabcdefabcdefabcdefabcdefab',
      host: '127.0.0.1',
      port: address.port,
      publicUrl: 'http://public.invalid',
    });
    await expect(new ServerStatusService().read(fixture.dataDir, limits)).resolves.toMatchObject({
      kind: 'running',
      status: { operationId: 'abcdefabcdefabcdefabcdefabcdefab', port: address.port },
    });
    let changed = false;
    http.on('request', () => {
      if (changed) {
        return;
      }
      changed = true;
      fixture.replaceStatus({
        phase: 'stopping',
        operationId: 'abcdefabcdefabcdefabcdefabcdefab',
      });
    });
    await expect(new ServerStatusService().read(fixture.dataDir, limits)).resolves.toEqual({
      kind: 'unknown',
    });
    await fixture.close();
  });

  it.each([
    [{ phase: 'starting', operationId: 'abcdefabcdefabcdefabcdefabcdefab' }, 'starting'],
    [{ phase: 'stopping', operationId: 'abcdefabcdefabcdefabcdefabcdefab' }, 'stopping'],
    [{ phase: 'stopped', operationId: 'abcdefabcdefabcdefabcdefabcdefab' }, 'stopped'],
    [{ phase: 'unknown' }, 'unknown'],
    [
      {
        phase: 'failed',
        operationId: 'abcdefabcdefabcdefabcdefabcdefab',
        code: 'revo.server-owner.stop',
        ownership: 'retained',
      },
      'failed',
    ],
  ] as const)('reports authenticated %s status as %s', async (status, kind) => {
    const fixture = await controlFixture(status);
    await expect(new ServerStatusService().read(fixture.dataDir, limits)).resolves.toEqual(
      kind === 'stopped' || kind === 'unknown' ? { kind } : { kind, status },
    );
    await fixture.close();
  });

  it.each([
    [{ phase: 'starting', operationId: 'wrong' }],
    [{ phase: 'restarting', operationId: 'abcdefabcdefabcdefabcdefabcdefab' }],
    [
      {
        phase: 'failed',
        operationId: 'abcdefabcdefabcdefabcdefabcdefab',
        code: 'revo.server-owner.stop',
        ownership: 'retained',
        extra: true,
      },
    ],
    [
      {
        phase: 'running',
        operationId: 'abcdefabcdefabcdefabcdefabcdefab',
        host: '127.0.0.1',
        port: 0,
        publicUrl: 'http://public.invalid',
      },
    ],
    [
      {
        phase: 'running',
        operationId: 'abcdefabcdefabcdefabcdefabcdefab',
        host: 'localhost',
        port: 3210,
        publicUrl: 'http://user:secret@public.invalid/?token=secret',
      },
    ],
  ] as const)('returns unknown for malformed or unsafe authenticated status %#', async (status) => {
    // @ts-expect-error The authenticated peer deliberately violates the status wire contract.
    const fixture = await controlFixture(status);
    await expect(new ControlClientService().requestStatus(fixture.record, limits)).rejects.toThrow(
      ControlTransportError,
    );
    await expect(new ServerStatusService().read(fixture.dataDir, limits)).resolves.toEqual({
      kind: 'unknown',
    });
    await fixture.close();
  });

  it.each([
    '{"data":{"__typename":"Mutation"}}',
    '{"data":{"__typename":"Query"},"errors":[]}',
    '{"data":{"__typename":"Query"}}' + ' '.repeat(limits.maxFrameBytes),
  ])('returns unknown for invalid local probe %#', async (body) => {
    const http = createServer((_request, response) => response.end(body));
    servers.push(http);
    await listenServer(http);
    const address = http.address();
    if (!address || typeof address === 'string') {
      throw new Error('HTTP fixture did not listen');
    }
    const failedProbe = await controlFixture({
      phase: 'running',
      operationId: 'abcdefabcdefabcdefabcdefabcdefab',
      host: '127.0.0.1',
      port: address.port,
      publicUrl: 'http://public.invalid',
    });
    await expect(new ServerStatusService().read(failedProbe.dataDir, limits)).resolves.toEqual({
      kind: 'unknown',
    });
    await failedProbe.close();
  });

  it('reports strict stop ownership for unsafe status and retained cleanup', async () => {
    const unsafe = await controlFixture({
      phase: 'running',
      operationId: 'abcdefabcdefabcdefabcdefabcdefab',
      host: '127.0.0.1/path',
      port: 3210,
      publicUrl: 'http://user:secret@public.invalid/?token=secret',
    });
    await expect(new ServerStatusService().read(unsafe.dataDir, limits)).resolves.toEqual({
      kind: 'unknown',
    });
    await unsafe.close();

    const retained = await controlFixture(
      { phase: 'stopped', operationId: 'abcdefabcdefabcdefabcdefabcdefab' },
      { kind: 'failed', ownership: 'retained' },
    );
    await expect(new ServerStopService().stop(retained.dataDir, 500, limits)).resolves.toEqual({
      kind: 'unconfirmed',
      ownership: 'retained',
    });
    await retained.close();
  });

  it('reports strict stop completion only after the endpoint confirms it', async () => {
    const completed = await controlFixture({
      phase: 'stopped',
      operationId: 'abcdefabcdefabcdefabcdefabcdefab',
    });
    await expect(new ServerStopService().stop(completed.dataDir, 500, limits)).resolves.toEqual({
      kind: 'completed',
    });
    await completed.close();
  });
});

async function controlFixture(
  status: ControlServerStatus,
  completion:
    | { readonly kind: 'completed' }
    | { readonly kind: 'failed'; readonly ownership: 'retained' | 'unconfirmed' } = {
    kind: 'completed',
  },
) {
  const root = await mkdtemp(join(tmpdir(), 'rs-'));
  roots.push(root);
  const dataDir = join(root, 'd');
  const runtimeDir = join(root, 'r');
  await Promise.all([mkdirPrivate(dataDir), mkdirPrivate(runtimeDir)]);
  const canonicalDataDir = await realpath(dataDir);
  const process = await new ProcessIdentityService().capture(globalThis.process.pid);
  const endpoint = await new ControlEndpointService().listen({
    runtimeDir,
    instanceId: '0123456789abcdef0123456789abcdef',
    token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    limits,
    identity: { version: '0.0.0', channel: 'stable', canonicalDataDir, process },
    onStatus: () => status,
    onStop: () => completion,
  });
  endpoints.push(endpoint);
  const record: ControlRecord = {
    schemaVersion: 1,
    instanceId: '0123456789abcdef0123456789abcdef',
    token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    endpoint: endpoint.endpoint,
    version: '0.0.0',
    channel: 'stable',
    canonicalDataDir,
    process,
  };
  await writeFile(join(dataDir, '.revo-control.json'), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
  return {
    dataDir,
    record,
    close: () => endpoint.close(),
    replaceStatus: (next: ControlServerStatus) => {
      status = next;
    },
  };
}

async function mkdirPrivate(directory: string): Promise<void> {
  await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { mode: 0o700 }));
  await chmod(directory, 0o700);
}

function listenServer(server: Server): Promise<void> {
  return bounded(new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
}

function closeServer(server: Server): Promise<void> {
  return bounded(new Promise((resolve) => server.close(() => resolve())));
}

function bounded(operation: Promise<void>): Promise<void> {
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('status fixture operation timed out')), 1_000),
    ),
  ]);
}
