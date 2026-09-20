import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigurationResolver } from '../../src/configuration/configuration-resolver.js';
import {
  MAX_STARTUP_TIMEOUT_MILLISECONDS,
  type RevoConfiguration,
} from '../../src/configuration/configuration.types.js';
import type { ProcessCompletion } from '../../src/processes/managed-process.types.js';
import type { ProgressEvent } from '../../src/progress/index.js';
import {
  SERVER_HOST_PROTOCOL,
  type ServerHostStartMessage,
} from '../../src/server/server-host-protocol.js';
import type {
  ServerLaunchOptions,
  ServerLaunchProcessPort,
  StartedServer,
} from '../../src/server/server-launch-attempt.js';
import type { ServerLaunchProcessService } from '../../src/server/server-launch-process.service.js';
import {
  ServerLauncherService,
  type ServerLaunchRequest,
} from '../../src/server/server-launcher.service.js';
import {
  ServerStartupObserver,
  type ServerProgressSink,
} from '../../src/server/server-startup-observer.js';
import type { ServerStatus, ServerStatusService } from '../../src/server/server-status.service.js';
import { ServerModule } from '../../src/server/server.module.js';
import type { StartupProgressDiscoveryService } from '../../src/startup-progress/index.js';

const attempt = vi.hoisted(() => ({
  ports: [] as ServerLaunchProcessPort[],
  start:
    vi.fn<
      (message: ServerHostStartMessage, options: ServerLaunchOptions) => Promise<StartedServer>
    >(),
}));

vi.mock('../../src/server/server-launch-attempt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server/server-launch-attempt.js')>()),
  ServerLaunchAttempt: class {
    readonly start = attempt.start;

    constructor(port: ServerLaunchProcessPort) {
      attempt.ports.push(port);
    }
  },
}));

const SERVER_ENTRY = fileURLToPath(new URL('../../src/bin/revo-server.js', import.meta.url));
const CLOCK = 1_700_000_000_000;
const SAFE_ENVIRONMENT = {
  CHECKPOINT_DISABLE: '1',
  HOME: '/home/revo',
  PATH: '/usr/bin:/bin',
  PGPASSFILE: '/dev/null',
  PGPASSWORD: '',
};

const request = (overrides: Partial<ServerLaunchRequest> = {}): Readonly<ServerLaunchRequest> =>
  Object.freeze({
    env: Object.freeze({
      DATABASE_URL: 'postgresql://forbidden@db/revo',
      HOME: '/home/revo',
      PATH: '/usr/bin:/bin',
      PGPASSWORD: 'do-not-leak',
      REVO_TOKEN: 'unrecognized',
    }),
    flags: Object.freeze({}),
    homeDir: '/home/revo',
    packageVersion: '2.5.1',
    platform: 'linux',
    signal: new AbortController().signal,
    ...overrides,
  });

const configuration = (overrides: Partial<RevoConfiguration> = {}): Readonly<RevoConfiguration> =>
  Object.freeze({
    channel: 'stable',
    configPath: '/home/revo/.config/revo/config.json',
    host: '0.0.0.0',
    installDir: '/home/revo/.local/share/revo-install/stable',
    layout: Object.freeze({
      cacheDir: '/home/revo/.cache/revo',
      channel: 'stable',
      configDir: '/home/revo/.config/revo',
      dataDir: '/home/revo/.local/share/revo',
      runtimeDir: '/home/revo/.local/state/revo/run',
      stateDir: '/home/revo/.local/state/revo',
    }),
    logDir: '/home/revo/.local/state/revo/logs',
    port: 3210,
    publicUrl: 'https://revo.example',
    startupTimeout: 5_000,
    ...overrides,
  });

type ResolveConfiguration = ConfigurationResolver['resolve'];
type ReadStatus = ServerStatusService['read'];
type StartLaunchProcess = ServerLaunchProcessService['start'];

const fakePort = () =>
  ({
    completion: new Promise<ProcessCompletion>(() => undefined),
    abandonUncertain: vi.fn<ServerLaunchProcessPort['abandonUncertain']>(async () => undefined),
    detachCommitted: vi.fn<ServerLaunchProcessPort['detachCommitted']>(async () => undefined),
    send: vi.fn<ServerLaunchProcessPort['send']>(async () => undefined),
    stop: vi.fn<ServerLaunchProcessPort['stop']>(async () => undefined),
    subscribe: vi.fn<ServerLaunchProcessPort['subscribe']>(() => () => undefined),
  }) satisfies ServerLaunchProcessPort;

const resolverFor = (resolved: Readonly<RevoConfiguration>) => ({
  resolve: vi.fn<ResolveConfiguration>(async () => resolved),
});
const statusFor = (status: ServerStatus) => ({ read: vi.fn<ReadStatus>(async () => status) });
const processesFor = (port: ServerLaunchProcessPort) => ({
  start: vi.fn<StartLaunchProcess>(async () => port),
});

@Injectable()
class LauncherConsumer {
  constructor(@Inject(ServerLauncherService) readonly launcher: ServerLauncherService) {}
}

@Module({ imports: [ServerModule], providers: [LauncherConsumer] })
// oxlint-disable-next-line typescript/no-extraneous-class -- Nest modules are decorator metadata
class LauncherConsumerModule {}

describe('server launcher composition', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    attempt.ports.length = 0;
    attempt.start.mockReset();
  });

  it('emits fresh healthy reuse with the verified public URL and no spawn or journal read', async () => {
    const read = vi.fn<StartupProgressDiscoveryService['read']>();
    const events: ProgressEvent[] = [];
    const processes = processesFor(fakePort());
    const current = {
      kind: 'running',
      status: {
        phase: 'running',
        publicUrl: 'https://verified.example',
        operationId: 'f'.repeat(32),
      },
    } as const;
    const service = new ServerLauncherService(
      resolverFor(configuration()),
      statusFor(current),
      processes,
      new ServerStartupObserver({ read }),
    );
    await expect(
      service.launch(
        request({
          onProgress: (event) => {
            events.push(event);
          },
        }),
      ),
    ).resolves.toBe(current);
    expect(events).toEqual([
      expect.objectContaining({
        status: 'ready',
        sequence: 1,
        reused: true,
        url: 'https://verified.example',
      }),
    ]);
    expect(events[0]?.operationId).not.toBe(current.status.operationId);
    expect(processes.start).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('shares the attempt operation and deadline with the journal observer', async () => {
    const observer = new ServerStartupObserver();
    const observe = vi.spyOn(observer, 'observe').mockImplementation(async (pending) => pending);
    const onProgress = vi.fn<ServerProgressSink>();
    attempt.start.mockResolvedValue({ kind: 'started', url: 'https://revo.example' });
    const service = new ServerLauncherService(
      resolverFor(configuration()),
      statusFor({ kind: 'stopped' }),
      processesFor(fakePort()),
      observer,
    );
    await service.launch(request({ onProgress }));
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]?.[1]).toMatchObject({
      operationId: attempt.start.mock.calls[0]?.[0].operationId,
      deadline: attempt.start.mock.calls[0]?.[1].deadline,
      sink: onProgress,
    });
  });

  it.each([
    ['channel root only', { REVO_ACTIVATION_CHANNEL_ROOT: '/private/channel' }],
    ['generation only', { REVO_ACTIVATION_GENERATION_ID: 'a'.repeat(64) }],
    [
      'bad generation',
      {
        REVO_ACTIVATION_CHANNEL_ROOT: '/private/channel',
        REVO_ACTIVATION_GENERATION_ID: 'not-a-generation',
      },
    ],
    [
      'relative channel root',
      {
        REVO_ACTIVATION_CHANNEL_ROOT: 'private/channel',
        REVO_ACTIVATION_GENERATION_ID: 'a'.repeat(64),
      },
    ],
  ] as const)('rejects $0 activation binding before starting the server', async (_label, env) => {
    const service = new ServerLauncherService(
      resolverFor(configuration()),
      statusFor({ kind: 'stopped' }),
      processesFor(fakePort()),
    );
    await expect(service.launch(request({ env }))).rejects.toThrow('activation binding is invalid');
    expect(attempt.start).not.toHaveBeenCalled();
  });

  it('propagates a resolver rejection beyond the maximum startup timeout without any launch work', async () => {
    const status = statusFor({ kind: 'stopped' });
    const processes = processesFor(fakePort());
    const service = new ServerLauncherService(new ConfigurationResolver(), status, processes);

    await expect(
      service.launch(request({ flags: { startupTimeout: MAX_STARTUP_TIMEOUT_MILLISECONDS + 1 } })),
    ).rejects.toMatchObject({
      code: 'revo.configuration.invalid',
      exitCode: 2,
      field: 'startupTimeout',
      source: 'flags',
    });
    expect(status.read).not.toHaveBeenCalled();
    expect(processes.start).not.toHaveBeenCalled();
    expect(attempt.ports).toEqual([]);
    expect(attempt.start).not.toHaveBeenCalled();
  });

  it.each<ServerStatus>([
    { kind: 'missing' },
    { kind: 'running', status: { phase: 'running' } },
    { kind: 'starting', status: { phase: 'starting' } },
    { kind: 'stopping', status: { phase: 'stopping' } },
    { kind: 'failed', status: { phase: 'failed' } },
    { kind: 'unknown' },
  ])('returns the $kind status identity without launching a server', async (current) => {
    const order: string[] = [];
    const resolved = configuration();
    const resolve = vi.fn<ResolveConfiguration>(async () => {
      order.push('resolve');
      return resolved;
    });
    const read = vi.fn<ReadStatus>(async () => {
      order.push('status');
      return current;
    });
    const processes = processesFor(fakePort());
    const input = request();

    const result = await new ServerLauncherService({ resolve }, { read }, processes).launch(input);

    expect(result).toBe(current);
    expect(order).toEqual(['resolve', 'status']);
    expect(resolve.mock.calls[0]?.[0]).toBe(input);
    expect(read).toHaveBeenCalledExactlyOnceWith(resolved.layout.dataDir);
    expect(processes.start).not.toHaveBeenCalled();
    expect(attempt.ports).toEqual([]);
    expect(attempt.start).not.toHaveBeenCalled();
  });

  it('returns the single configuration snapshot used for the start decision and launch message', async () => {
    const resolved = configuration({
      databaseUrl: 'postgresql://user:secret@db.example/revo',
      host: '192.0.2.10',
      logDir: '/fixture/logs-a',
      port: 4321,
      publicUrl: 'https://revo.example/a',
      startupTimeout: 12_345,
    });
    const resolve = vi.fn<ResolveConfiguration>(async () => resolved);
    const read = vi.fn<ReadStatus>(async () => ({ kind: 'stopped' }));
    const started: StartedServer = { kind: 'started', url: resolved.publicUrl };
    attempt.start.mockResolvedValue(started);
    const input = request();
    const service = new ServerLauncherService({ resolve }, { read }, processesFor(fakePort()));

    const result = await service.launchWithConfiguration(input);

    expect(result).toEqual({ configuration: resolved, outcome: started });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(input);
    expect(read).toHaveBeenCalledExactlyOnceWith(resolved.layout.dataDir);
    expect(attempt.start.mock.calls[0]?.[0].configuration).toMatchObject({
      databaseUrl: 'postgresql://user:secret@db.example/revo',
      dataDir: resolved.layout.dataDir,
      host: resolved.host,
      logDir: resolved.logDir,
      port: resolved.port,
      publicUrl: resolved.publicUrl,
      runtimeDir: resolved.layout.runtimeDir,
      startupTimeout: resolved.startupTimeout,
    });
  });

  it.each([
    { label: 'an external database URL', databaseUrl: 'postgresql://user:secret@db/revo' },
    { label: 'no database URL', databaseUrl: undefined },
  ])('launches a stopped server bound to $label', async ({ databaseUrl }) => {
    vi.spyOn(Date, 'now').mockReturnValue(CLOCK);
    vi.stubEnv('TMPDIR', '/ambient-only');
    const resolved = configuration(databaseUrl === undefined ? {} : { databaseUrl });
    const started: StartedServer = { kind: 'started', url: resolved.publicUrl };
    attempt.start.mockResolvedValue(started);
    const port = fakePort();
    const processes = processesFor(port);
    const input = request();
    const service = new ServerLauncherService(
      resolverFor(resolved),
      statusFor({ kind: 'stopped' }),
      processes,
    );

    const result = await service.launch(input);

    expect(result).toBe(started);
    expect(attempt.ports).toHaveLength(1);
    expect(attempt.ports[0]).toBe(port);
    expect(processes.start.mock.calls).toStrictEqual([
      [
        {
          cwd: dirname(SERVER_ENTRY),
          entry: SERVER_ENTRY,
          env: SAFE_ENVIRONMENT,
          executable: process.execPath,
        },
        { graceMs: 500, killWaitMs: 2_500, signal: input.signal },
      ],
    ]);
    expect(attempt.start.mock.calls).toStrictEqual([
      [
        {
          protocol: SERVER_HOST_PROTOCOL,
          type: 'start',
          operationId: expect.stringMatching(/^[0-9a-f]{32}$/u),
          mode: 'detached',
          configuration: {
            channel: 'stable',
            dataDir: resolved.layout.dataDir,
            ...(databaseUrl === undefined ? {} : { databaseUrl }),
            host: '0.0.0.0',
            logDir: resolved.logDir,
            port: 3210,
            publicUrl: 'https://revo.example',
            runtimeDir: resolved.layout.runtimeDir,
            startupTimeout: resolved.startupTimeout,
            version: input.packageVersion,
          },
          environment: SAFE_ENVIRONMENT,
        },
        { deadline: CLOCK + resolved.startupTimeout, signal: input.signal },
      ],
    ]);
  });

  it('starts the launch deadline after the status gate and before the process work', async () => {
    let now = CLOCK;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const resolved = configuration();
    const resolve = vi.fn<ResolveConfiguration>(async () => {
      now = CLOCK + 10;
      return resolved;
    });
    const read = vi.fn<ReadStatus>(async () => {
      now = CLOCK + 20;
      return { kind: 'stopped' };
    });
    const start = vi.fn<StartLaunchProcess>(async () => {
      now = CLOCK + 5_000;
      return fakePort();
    });
    attempt.start.mockResolvedValue({ kind: 'started', url: resolved.publicUrl });

    await new ServerLauncherService({ resolve }, { read }, { start }).launch(request());

    expect(attempt.start.mock.calls[0]?.[1].deadline).toBe(CLOCK + 20 + resolved.startupTimeout);
  });

  it('propagates an attempt rejection without stopping the launch process itself', async () => {
    const failure = new Error('attempt rejected');
    attempt.start.mockRejectedValue(failure);
    const port = fakePort();
    const service = new ServerLauncherService(
      resolverFor(configuration()),
      statusFor({ kind: 'stopped' }),
      processesFor(port),
    );

    await expect(service.launch(request())).rejects.toBe(failure);
    expect(port.stop).not.toHaveBeenCalled();
  });

  it('exports the launcher from ServerModule to an importing consumer module', async () => {
    const application = await NestFactory.createApplicationContext(LauncherConsumerModule, {
      logger: false,
    });

    try {
      expect(application.get(LauncherConsumer).launcher).toBeInstanceOf(ServerLauncherService);
    } finally {
      await application.close();
    }
  });
});
