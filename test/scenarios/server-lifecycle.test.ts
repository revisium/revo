import { afterEach, describe, expect, it } from 'vitest';

import {
  parseLifecycleDocument,
  serializeLifecycleDocument,
} from '../../src/server-logs/document.js';
import { openServerLifecycleStore } from '../../src/server-logs/store.service.js';
import { event, ServerLifecycleScenario } from '../support/server/server-lifecycle-scenario.js';

const scenarios: ServerLifecycleScenario[] = [];

afterEach(async () => {
  await Promise.all(scenarios.splice(0).map((scenario) => scenario.dispose()));
});

describe('private server lifecycle journal', () => {
  it('appends, evicts oldest records, and resumes sequence after reopen', async () => {
    const scenario = await fixture();
    const store = await scenario.open();
    await Array.from({ length: 129 }).reduce<Promise<void>>(
      (previous) => previous.then(() => store.emit('SERVER_STARTING')),
      Promise.resolve(),
    );
    await store.close();
    const document = await scenario.document();
    expect(document?.events).toHaveLength(128);
    expect(document?.events[0]).toEqual({
      sequence: 2,
      time: 1_700_000_000_000,
      phase: 'server',
      state: 'starting',
      code: 'SERVER_STARTING',
    });
    expect(document?.events.at(-1)?.sequence).toBe(129);
    const successor = await scenario.open();
    await successor.emit('SERVER_READY');
    await successor.close();
    expect((await scenario.document())?.events.at(-1)?.sequence).toBe(130);
  });

  it('creates separate files for each channel and canonical data directory', async () => {
    const scenario = await fixture();
    const stores = await Promise.all([
      scenario.open({ channel: 'stable' }),
      scenario.open({ channel: 'alpha' }),
      scenario.open({ canonicalDataDir: scenario.otherDataDir }),
    ]);
    await Promise.all([
      stores[0].emit('SERVER_STARTING'),
      stores[1].emit('DATABASE_STARTING'),
      stores[2].emit('SERVER_READY'),
    ]);
    await Promise.all(stores.map((store) => store.close()));
    const paths = [
      scenario.path({ channel: 'stable' }),
      scenario.path({ channel: 'alpha' }),
      scenario.path({ canonicalDataDir: scenario.otherDataDir }),
    ];
    expect(new Set(paths).size).toBe(3);
    expect(paths.every((path) => /\/[0-9a-f]{64}\/server-lifecycle\.json$/u.test(path))).toBe(true);
    expect((await scenario.document({ channel: 'alpha' }))?.events[0]?.code).toBe(
      'DATABASE_STARTING',
    );
  });

  it('rejects unknown fields and every invalid schema value', () => {
    const base = event(1, 'SERVER_STARTING');
    const invalid = [
      { schemaVersion: 2, events: [base] },
      { schemaVersion: 1, events: [base], extra: true },
      { schemaVersion: 1, events: [{ ...base, extra: true }] },
      { schemaVersion: 1, events: [{ ...base, code: 'NOPE' }] },
      { schemaVersion: 1, events: [{ ...base, phase: 'nope' }] },
      { schemaVersion: 1, events: [{ ...base, state: 'nope' }] },
      { schemaVersion: 1, events: [{ ...base, time: -1 }] },
      { schemaVersion: 1, events: [{ ...base, time: Number.MAX_SAFE_INTEGER + 1 }] },
      { schemaVersion: 1, events: [{ ...base, sequence: 0 }] },
      {
        schemaVersion: 1,
        events: [
          { ...base, sequence: 1 },
          { ...base, sequence: 3 },
        ],
      },
      { schemaVersion: 1, events: 'not-an-array' },
    ];
    invalid.forEach((value) =>
      expect(parseLifecycleDocument(JSON.stringify(value))).toBeUndefined(),
    );
    expect(() =>
      serializeLifecycleDocument([event(1, 'SERVER_STARTING'), event(3, 'SERVER_READY')]),
    ).toThrow('Invalid server lifecycle document');
    expect(parseLifecycleDocument('x'.repeat(65_537))).toBeUndefined();
  });

  it('recovers only valid newer temporary history and removes stale valid temp', async () => {
    const cases = [
      [[event(1, 'SERVER_STARTING')], [event(2, 'SERVER_READY', 'server', 'ready')], 2],
      [[event(2, 'SERVER_READY', 'server', 'ready')], [event(1, 'SERVER_STARTING')], 2],
      [undefined, [event(4, 'DATABASE_READY', 'postgres', 'ready')], 4],
    ] as const;
    await Promise.all(
      cases.map(async ([target, temporary, last]) => {
        const scenario = await fixture();
        await (target && scenario.seed('target', serializeLifecycleDocument(target)));
        await scenario.seed('temp', serializeLifecycleDocument(temporary));
        const store = await scenario.open();
        await store.close();
        expect((await scenario.document())?.events.at(-1)?.sequence).toBe(last);
        expect(await scenario.raw('temp').catch(() => undefined)).toBeUndefined();
      }),
    );
  });

  it('leaves malformed, oversized, or unsafe history untouched', async () => {
    const cases = [
      ['target', '{"schemaVersion":1,"events":[{"bad":true}]}'],
      ['temp', '{"schemaVersion":1,"events":[{"bad":true}]}'],
      ['target', 'x'.repeat(65_537)],
      ['temp', 'x'.repeat(65_537)],
    ] as const;
    await Promise.all(
      cases.map(async ([name, content]) => {
        const scenario = await fixture();
        await scenario.seed(name, content);
        const before = await scenario.raw(name);
        expect(await openServerLifecycleStore(scenario.configuration())).toBeUndefined();
        expect(await scenario.raw(name)).toBe(before);
      }),
    );
  });

  it.each([
    ['target', 'symlink'],
    ['target', 'fifo'],
    ['target', 'hardlink'],
    ['temp', 'symlink'],
    ['temp', 'fifo'],
    ['temp', 'hardlink'],
  ] as const)('rejects %s %s without following it', async (name, kind) => {
    const scenario = await fixture();
    await scenario.unsafe(name, kind);
    expect(await openServerLifecycleStore(scenario.configuration())).toBeUndefined();
  });

  it('rejects insecure permissions and an unsafe parent before child operations', async () => {
    const scenario = await fixture();
    await scenario.seed('target', serializeLifecycleDocument([event(1, 'SERVER_STARTING')]));
    await scenario.mode('target', 0o644);
    expect(await openServerLifecycleStore(scenario.configuration())).toBeUndefined();
    expect(await openServerLifecycleStore(await scenario.replaceParentWithFile())).toBeUndefined();
  });

  it('disables after a write fault, rejects saturation, and drains close', async () => {
    const scenario = await fixture();
    const store = await scenario.open();
    const accepted = Array.from({ length: 128 }, () => store.emit('SERVER_STARTING'));
    const overflow = store.emit('SERVER_READY');
    await expect(overflow).rejects.toMatchObject({ reason: 'limit' });
    await Promise.all(accepted);
    await Promise.all([store.close(), store.close()]);
    expect((await scenario.document())?.events).toHaveLength(128);

    const failed = await scenario.open({ canonicalDataDir: scenario.otherDataDir });
    await scenario.unsafe('temp', 'fifo', { canonicalDataDir: scenario.otherDataDir });
    await expect(failed.emit('SERVER_STARTING')).rejects.toMatchObject({ reason: 'io' });
    await failed.emit('SERVER_READY');
    await failed.close();
  });

  it('does not write after close, exposes no raw error, and rejects sequence overflow', async () => {
    const scenario = await fixture();
    const store = await scenario.open();
    await store.emit('SERVER_STARTING');
    await store.close();
    const before = await scenario.raw('target');
    await store.emit('SERVER_READY');
    expect(await scenario.raw('target')).toBe(before);

    const invalid = await scenario.open({ canonicalDataDir: scenario.otherDataDir });
    const secret = 'secret-sentinel-should-never-escape';
    await expect(Reflect.apply(invalid['emit'], invalid, [secret])).rejects.toMatchObject({
      reason: 'invalid',
      message: 'Server lifecycle journal failed',
    });
    await invalid.close();

    const overflow = await fixture();
    await overflow.seed(
      'target',
      serializeLifecycleDocument([
        event(Number.MAX_SAFE_INTEGER, 'SERVER_READY', 'server', 'ready'),
      ]),
    );
    expect(await openServerLifecycleStore(overflow.configuration())).toBeUndefined();
  });
});

async function fixture(): Promise<ServerLifecycleScenario> {
  const scenario = await ServerLifecycleScenario.create();
  scenarios.push(scenario);
  return scenario;
}
