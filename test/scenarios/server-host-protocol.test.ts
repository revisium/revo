import { describe, expect, it } from 'vitest';

import { parseServerHostParentMessage } from '../../src/server/server-host-protocol.js';
import { validStartMessage } from '../support/server/server-host-message.js';

describe('Private server host protocol', () => {
  it('accepts a validated resolved configuration including private port zero', () => {
    const message = validStartMessage({
      configuration: { ...validStartMessage().configuration, port: 0 },
    });
    expect(parseServerHostParentMessage(message)).toEqual(message);
  });

  it('accepts a complete activation binding and rejects partial bindings', () => {
    const valid = validStartMessage({
      configuration: {
        ...validStartMessage().configuration,
        activation: { channelRoot: '/private/channel', generationId: 'a'.repeat(64) },
      },
    });
    expect(parseServerHostParentMessage(valid)).toEqual(valid);
    for (const activation of [
      { channelRoot: '/private/channel' },
      { generationId: 'a'.repeat(64) },
      { channelRoot: 'relative', generationId: 'a'.repeat(64) },
      { channelRoot: '/private/channel', generationId: 'invalid' },
    ]) {
      expect(
        parseServerHostParentMessage({
          ...valid,
          configuration: { ...valid.configuration, activation },
        }),
      ).toBeUndefined();
    }
  });

  it.each([
    ['operation', { operationId: 'ABCDEF0123456789ABCDEF0123456789' }],
    ['channel', { configuration: { ...validStartMessage().configuration, channel: 'preview' } }],
    ['version', { configuration: { ...validStartMessage().configuration, version: 'latest' } }],
    ['host', { configuration: { ...validStartMessage().configuration, host: 'bad host' } }],
    [
      'public URL',
      {
        configuration: {
          ...validStartMessage().configuration,
          publicUrl: 'https://user:secret@example.test',
        },
      },
    ],
    ['environment NUL', { environment: { HOME: '/private\0home' } }],
    [
      'environment count',
      {
        environment: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`ENV_${index}`, 'value']),
        ),
      },
    ],
    [
      'serialized size',
      {
        environment: Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [`LARGE_${index}`, 'x'.repeat(32 * 1024)]),
        ),
      },
    ],
  ])('rejects an otherwise valid message with invalid %s', (_name, override) => {
    expect(parseServerHostParentMessage(validStartMessage(override))).toBeUndefined();
  });
});
