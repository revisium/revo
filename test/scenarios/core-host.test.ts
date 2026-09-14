import { describe, expect, it } from 'vitest';

import {
  CORE_HOST_PROTOCOL,
  isCoreHostMessage,
  parseCoreHostMessage,
} from '../../src/core-host/core-child-protocol.js';
import { CoreStageBridge } from '../../src/core-host/core-stage-bridge.js';
import { CoreHostScenario } from '../support/core-host/core-host-scenario.js';

describe('Core host protocol', () => {
  it('accepts the strict start contract and rejects unknown or relative fields', () => {
    const message = {
      protocol: CORE_HOST_PROTOCOL,
      type: 'start',
      databaseUrl: 'postgresql://localhost/revo',
      temporaryWorkingDirectoryRoot: '/tmp/revo-work',
      agentWorkspaceDirectory: '/srv/revo-sessions',
      host: '127.0.0.1',
      port: 4100,
    };
    expect(parseCoreHostMessage(message)).toEqual(message);
    expect(
      isCoreHostMessage({
        ...message,
        databaseUrl: 'postgresql://user:secret@db/revo',
        extra: true,
      }),
    ).toBe(false);
    expect(isCoreHostMessage({ ...message, agentWorkspaceDirectory: 'sessions' })).toBe(false);
  });

  it('does not accept raw errors or listening as readiness', () => {
    expect(
      isCoreHostMessage({ protocol: CORE_HOST_PROTOCOL, type: 'failed', code: 'secret details' }),
    ).toBe(false);
    expect(
      isCoreHostMessage({
        protocol: CORE_HOST_PROTOCOL,
        type: 'listening',
        host: '127.0.0.1',
        port: 4100,
        url: 'http://127.0.0.1:4100',
      }),
    ).toBe(true);
  });
});

describe('Core stage bridge', () => {
  it('serializes synchronous stage notifications in order and drains them', async () => {
    const scenario = new CoreHostScenario();
    const bridge = new CoreStageBridge(scenario.send);
    bridge.onStage({ stage: 'application-bootstrap', status: 'started' });
    bridge.onStage({ stage: 'application-bootstrap', status: 'completed' });
    bridge.onStage({ stage: 'api-readiness', status: 'started' });
    await bridge.drain();
    expect(
      scenario.sent.map(
        (message) => message.type === 'stage' && `${message.stage}:${message.status}`,
      ),
    ).toEqual([
      'application-bootstrap:started',
      'application-bootstrap:completed',
      'api-readiness:started',
    ]);
  });

  it('latches the first async transport failure as a safe error', async () => {
    const scenario = new CoreHostScenario();
    const bridge = new CoreStageBridge(scenario.send);
    scenario.failSending();
    expect(() => bridge.onStage({ stage: 'api-readiness', status: 'started' })).not.toThrow();
    await expect(bridge.drain()).rejects.toMatchObject({
      name: 'CoreStageBridgeError',
      message: 'Core stage bridge could not send an event',
    });
  });
});
