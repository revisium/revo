import process from 'node:process';

import { vi } from 'vitest';

import type { ServerHostProcessPort } from '../../../src/server/server-host-process-port.js';
import type { ServerHostChildMessage } from '../../../src/server/server-host-protocol.js';
import type {
  OpenServerOwnerRequest,
  ServerOwnerOutcome,
} from '../../../src/server/server-owner.service.js';
import { validStartMessage } from './server-host-message.js';

type HeldOwner = {
  readonly kind: 'held';
  start(signal: AbortSignal): Promise<{ readonly kind: 'ready'; readonly url: string }>;
  close(): Promise<void>;
  outcome(): Promise<ServerOwnerOutcome>;
  ownershipReleased(): Promise<void>;
};

export function heldOwner(): HeldOwner {
  return {
    kind: 'held',
    start: async () => ({ kind: 'ready', url: 'http://127.0.0.1:3210' }),
    close: async () => undefined,
    outcome: async () => ({ kind: 'stopped' }),
    ownershipReleased: () => new Promise(() => undefined),
  };
}

export async function executeRevoServerBin(options: {
  readonly nestFailure?: Error;
  readonly owner?: { readonly kind: 'busy' } | HeldOwner;
  readonly rejectSend?: boolean;
  readonly rejectPortClose?: boolean;
}) {
  const originalExitCode = process.exitCode;
  const request = validStartMessage({ mode: 'foreground' });
  const sent: ServerHostChildMessage[] = [];
  const sendDeadlineRemaining: number[] = [];
  const portCloseDeadlineRemaining: number[] = [];
  const contextArguments: unknown[][] = [];
  const contextGetTokens: unknown[] = [];
  const openRequests: OpenServerOwnerRequest[] = [];
  const openResults: unknown[] = [];
  const ownerStartReceivers: unknown[] = [];
  const ownerStartSignals: AbortSignal[] = [];
  const ownerOutcomeReceivers: unknown[] = [];
  let applicationCloseCalls = 0;
  let ownerOutcomeCalls = 0;
  let ownerCloseCalls = 0;
  let messageListener: (message: unknown) => void = () => undefined;
  let startDelivery: NodeJS.Immediate | undefined;

  const selectedOwner = options.owner ?? heldOwner();
  const observedOwner =
    selectedOwner.kind === 'busy'
      ? selectedOwner
      : {
          kind: selectedOwner.kind,
          start(this: unknown, signal: AbortSignal) {
            ownerStartReceivers.push(this);
            ownerStartSignals.push(signal);
            return selectedOwner.start(signal);
          },
          close: () => {
            ownerCloseCalls += 1;
            return selectedOwner.close();
          },
          outcome(this: unknown) {
            ownerOutcomeReceivers.push(this);
            ownerOutcomeCalls += 1;
            return selectedOwner.outcome();
          },
          ownershipReleased: () => selectedOwner.ownershipReleased(),
        };
  const owners = {
    open: async (value: OpenServerOwnerRequest) => {
      openRequests.push(value);
      openResults.push(observedOwner);
      return observedOwner;
    },
  };
  const port: ServerHostProcessPort = {
    connected: () => true,
    onDisconnect: () => undefined,
    onMessage: (listener) => {
      messageListener = listener;
    },
    onSignal: () => undefined,
    send: async (message, deadline) => {
      sent.push(message);
      sendDeadlineRemaining.push(deadline - Date.now());
      if (options.rejectSend) {
        throw new Error('fixture send rejection');
      }
      if (message.type === 'booted') {
        startDelivery = setImmediate(() => messageListener(request));
      }
    },
    close: async (deadline) => {
      portCloseDeadlineRemaining.push(deadline - Date.now());
      if (options.rejectPortClose) {
        throw new Error('fixture close rejection');
      }
    },
    setExitCode: (exitCode) => {
      process.exitCode = exitCode;
    },
  };

  try {
    vi.doMock('../../../src/server/server-host-process-port.js', () => ({
      NodeServerHostProcessPort: function () {
        return port;
      },
    }));
    vi.doMock('@nestjs/core', () => ({
      NestFactory: {
        createApplicationContext: async (...args: unknown[]) => {
          contextArguments.push(args);
          if (options.nestFailure) {
            throw options.nestFailure;
          }
          return {
            get: (token: unknown) => {
              contextGetTokens.push(token);
              return owners;
            },
            close: async () => {
              applicationCloseCalls += 1;
            },
          };
        },
      },
    }));
    await bounded(import('../../../src/bin/revo-server.js'));
    return {
      contextArguments,
      contextGetTokens,
      applicationCloseCalls,
      openRequests,
      openResults,
      ownerStartReceivers,
      ownerStartSignals,
      ownerOutcomeReceivers,
      ownerOutcomeCalls,
      ownerCloseCalls,
      sent,
      sendDeadlineRemaining,
      portCloseDeadlineRemaining,
      exitCode: process.exitCode,
    };
  } finally {
    if (startDelivery) {
      clearImmediate(startDelivery);
    }
    process.exitCode = originalExitCode;
    vi.doUnmock('../../../src/server/server-host-process-port.js');
    vi.doUnmock('@nestjs/core');
    vi.resetModules();
  }
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('revo-server bin fixture exceeded 1 second')), 1_000);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
