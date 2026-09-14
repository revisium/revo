import { describe, expect, it } from 'vitest';

import { SERVER_HOST_PROTOCOL } from '../../src/server/server-host-protocol.js';
import { ServerOwnerService } from '../../src/server/server-owner.service.js';
import { ServerModule } from '../../src/server/server.module.js';
import { executeRevoServerBin, heldOwner } from '../support/server/revo-server-bin-scenario.js';
import { validStartMessage } from '../support/server/server-host-message.js';

describe('Revo server executable composition', () => {
  it('boots the real host entry and reports busy ownership with the exact request', async () => {
    const observations = await executeRevoServerBin({ owner: { kind: 'busy' } });
    const start = validStartMessage({ mode: 'foreground' });

    expect(observations.sent).toEqual([
      { protocol: SERVER_HOST_PROTOCOL, type: 'booted' },
      {
        protocol: SERVER_HOST_PROTOCOL,
        type: 'failed',
        operationId: start.operationId,
        code: 'SERVER_HOST_BUSY',
      },
    ]);
    expect(observations.openRequests).toEqual([
      {
        configuration: start.configuration,
        environment: start.environment,
        operationId: start.operationId,
        trustedEnvironmentNames: ['HOME', 'PATH'],
      },
    ]);
    expect(observations.contextArguments).toEqual([[ServerModule, { logger: false }]]);
    expect(observations.contextGetTokens).toEqual([ServerOwnerService]);
    expect(observations.applicationCloseCalls).toBe(1);
  });

  it('passes the held owner through start and outcome before closing both boundaries', async () => {
    const owner = heldOwner();
    const observations = await executeRevoServerBin({ owner });

    expect(observations.ownerStartReceivers).toEqual(observations.openResults);
    expect(observations.ownerOutcomeReceivers).toEqual(observations.openResults);
    expect(observations.ownerStartSignals).toHaveLength(1);
    expect(observations.ownerOutcomeCalls).toBe(1);
    expect(observations.ownerCloseCalls).toBe(0);
    expect(observations.portCloseDeadlineRemaining).toHaveLength(1);
    expect(observations.applicationCloseCalls).toBe(1);
    expect(observations.exitCode).toBe(0);
  });

  it('bounds generic failure delivery without disclosing the Nest boot rejection', async () => {
    const observations = await executeRevoServerBin({
      nestFailure: new Error('database password is swordfish'),
    });

    expect(observations.sent).toEqual([
      { protocol: SERVER_HOST_PROTOCOL, type: 'failed', code: 'SERVER_HOST_FAILED' },
    ]);
    expect(JSON.stringify(observations.sent)).not.toContain('swordfish');
    expect(observations.sendDeadlineRemaining[0]).toBeGreaterThan(0);
    expect(observations.sendDeadlineRemaining[0]).toBeLessThanOrEqual(250);
    expect(observations.portCloseDeadlineRemaining[0]).toBeGreaterThan(0);
    expect(observations.portCloseDeadlineRemaining[0]).toBeLessThanOrEqual(250);
    expect(observations.exitCode).toBe(1);
  });

  it('settles safely with nonzero status when failure send and close both reject', async () => {
    const observations = await executeRevoServerBin({
      nestFailure: new Error('boot failed'),
      rejectSend: true,
      rejectPortClose: true,
    });

    expect(observations.sent).toHaveLength(1);
    expect(observations.portCloseDeadlineRemaining).toHaveLength(1);
    expect(observations.exitCode).toBe(1);
  });
});
