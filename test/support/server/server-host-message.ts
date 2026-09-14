import {
  SERVER_HOST_PROTOCOL,
  type ServerHostParentMessage,
} from '../../../src/server/server-host-protocol.js';

export const OPERATION_ID = '0123456789abcdef0123456789abcdef';

export function validStartMessage(
  overrides: Partial<Extract<ServerHostParentMessage, { readonly type: 'start' }>> = {},
): Extract<ServerHostParentMessage, { readonly type: 'start' }> {
  return {
    protocol: SERVER_HOST_PROTOCOL,
    type: 'start',
    operationId: OPERATION_ID,
    mode: 'detached',
    configuration: {
      channel: 'stable',
      dataDir: '/private/data',
      host: '127.0.0.1',
      port: 3210,
      publicUrl: 'http://127.0.0.1:3210',
      runtimeDir: '/private/run',
      startupTimeout: 5_000,
      version: '0.0.0',
    },
    environment: { HOME: '/private/home', PATH: '/private/node/bin' },
    ...overrides,
  };
}
