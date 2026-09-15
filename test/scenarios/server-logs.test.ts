import { access } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { ServerLogsCommandService } from '../../src/cli/server-logs-command.service.js';
import type { RevoConfiguration } from '../../src/configuration/configuration.types.js';
import { resolveRevoLayout } from '../../src/layout.js';
import { follow } from '../../src/server-logs/follow.js';
import { ServerLifecycleReader } from '../../src/server-logs/reader.service.js';
import { ServerLogsScenario, retainedEvents } from '../support/server-logs/server-logs-scenario.js';

describe('server lifecycle log reader', () => {
  it('reads an ordered snapshot and advances from a cursor', async () => {
    const scenario = await ServerLogsScenario.open();
    try {
      await scenario.append(3);

      await expect(scenario.read()).resolves.toMatchObject({
        kind: 'ready',
        cursor: 3,
        reset: false,
        events: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }],
      });
      await expect(scenario.read(1)).resolves.toMatchObject({
        kind: 'ready',
        cursor: 3,
        reset: false,
        events: [{ sequence: 2 }, { sequence: 3 }],
      });
    } finally {
      await scenario.cleanup();
    }
  });

  it('reports missing logs without creating directories or files', async () => {
    const scenario = await ServerLogsScenario.open();
    try {
      await expect(scenario.read()).resolves.toEqual({
        kind: 'missing',
        cursor: 0,
        events: [],
        reset: false,
      });
    } finally {
      await scenario.cleanup();
    }
  });

  it('follows atomic replacements and reports a retained-history reset', async () => {
    const scenario = await ServerLogsScenario.open();
    try {
      await scenario.append(retainedEvents + 2);
      const snapshot = await scenario.read();
      expect(snapshot).toMatchObject({ kind: 'ready', cursor: retainedEvents + 2 });
      await scenario.appendReady();

      await expect(scenario.read(snapshot.cursor)).resolves.toMatchObject({
        kind: 'ready',
        cursor: retainedEvents + 3,
        reset: false,
        events: [{ sequence: retainedEvents + 3 }],
      });
      const reset = await scenario.read(1);
      if (reset.kind !== 'ready') {
        throw new Error(`Expected retained snapshot, got ${reset.kind}`);
      }
      expect(reset.reset).toBe(true);
      expect(reset.events[0]?.sequence).toBe(4);
    } finally {
      await scenario.cleanup();
    }
  });

  it('ignores a temporary replacement file and never recovers it', async () => {
    const scenario = await ServerLogsScenario.open();
    try {
      const temporary = await scenario.installTemporaryDocument();

      await expect(scenario.read()).resolves.toMatchObject({ kind: 'missing' });
      await expect(access(temporary)).resolves.toBeUndefined();
    } finally {
      await scenario.cleanup();
    }
  });

  it.each([
    ['malformed', (scenario: ServerLogsScenario) => scenario.installMalformedDocument()],
    ['oversized', (scenario: ServerLogsScenario) => scenario.installOversizedDocument()],
    ['symlink', (scenario: ServerLogsScenario) => scenario.installTargetSymlink()],
    ['insecure', (scenario: ServerLogsScenario) => scenario.installInsecureDocument()],
  ] as const)('rejects an unsafe %s document', async (_kind, install) => {
    const scenario = await ServerLogsScenario.open();
    try {
      await install(scenario);
      await expect(scenario.read()).resolves.toMatchObject({ kind: 'invalid', events: [] });
    } finally {
      await scenario.cleanup();
    }
  });

  it('pins the canonical identity before follow reads', async () => {
    const scenario = await ServerLogsScenario.open();
    try {
      const reader = await ServerLifecycleReader.open(scenario.configuration());
      await scenario.append(1);
      const first = await reader.read();
      await scenario.appendReady();

      await expect(reader.read(first.cursor)).resolves.toMatchObject({
        kind: 'ready',
        events: [{ code: 'SERVER_READY' }],
      });
    } finally {
      await scenario.cleanup();
    }
  });

  it('follows snapshots through an injected wait without sleeping', async () => {
    const controller = new AbortController();
    const cursors: number[] = [];
    const snapshots = [
      { cursor: 2, events: [1, 2] },
      { cursor: 3, events: [3] },
    ];
    let waits = 0;

    await follow({
      read: async (cursor) => {
        cursors.push(cursor);
        return snapshots[cursors.length - 1] ?? { cursor: 0, events: [] };
      },
      wait: async () => {
        waits += 1;
        if (waits === 2) {
          controller.abort();
        }
      },
      signal: controller.signal,
      onSnapshot: () => undefined,
    });

    expect(cursors).toEqual([0, 2]);
    expect(waits).toBe(2);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('maps %s to a clean follow exit and removes listeners', async (signal, exitCode) => {
    const scenario = await ServerLogsScenario.open();
    try {
      await scenario.append(1);
      const lifecycle = scenario.configuration();
      const configuration: RevoConfiguration = {
        channel: 'stable',
        configPath: '/fixture/config.json',
        host: '127.0.0.1',
        installDir: '/fixture/install',
        layout: {
          ...resolveRevoLayout({
            channel: 'stable',
            env: {},
            homeDir: '/fixture',
            platform: 'linux',
          }),
          dataDir: lifecycle.canonicalDataDir,
        },
        logDir: lifecycle.logDir,
        port: 3210,
        publicUrl: 'http://127.0.0.1:3210',
        startupTimeout: 180_000,
      };
      const output: string[] = [];
      const baseline = process.listenerCount(signal);
      const service = new ServerLogsCommandService(
        { resolve: async () => configuration },
        { version: '0.0.0' },
        { write: (message: string) => output.push(message) },
        async (waitSignal) => {
          await Promise.resolve();
          process.emit(signal);
          expect(waitSignal.aborted).toBe(true);
        },
      );

      await expect(service.logs({ follow: true })).rejects.toMatchObject({ exitCode });
      expect(output).toHaveLength(1);
      expect(process.listenerCount(signal)).toBe(baseline);
    } finally {
      await scenario.cleanup();
    }
  });
});
