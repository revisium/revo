import { describe, expect, it } from 'vitest';

import { assertActivationTestModes } from './support/installation/activation-test-modes.js';

describe('activation test mode guard', () => {
  it.each([
    ['both modes absent', {}, {}],
    ['fault mode alone', { REVO_TEST_ACTIVATION_FAULT: 'cancel' }, {}],
    ['diagnostics alone', { REVO_TEST_ACTIVATION_DIAGNOSTICS: '1' }, {}],
    [
      'extra diagnostics override inherited invalid mode',
      { REVO_TEST_ACTIVATION_DIAGNOSTICS: '1' },
      { REVO_TEST_ACTIVATION_DIAGNOSTICS: '0' },
    ],
    [
      'extra empty fault suppresses inherited fault',
      { REVO_TEST_ACTIVATION_FAULT: '' },
      { REVO_TEST_ACTIVATION_FAULT: 'cancel', REVO_TEST_ACTIVATION_DIAGNOSTICS: '1' },
    ],
    [
      'undefined extra value inherits diagnostics mode',
      { REVO_TEST_ACTIVATION_DIAGNOSTICS: undefined },
      { REVO_TEST_ACTIVATION_DIAGNOSTICS: '1' },
    ],
  ] as const)('allows %s', (_label, extra, inherited) => {
    expect(() =>
      assertActivationTestModes(Object.freeze(extra), Object.freeze(inherited)),
    ).not.toThrow();
  });

  it.each([
    [
      'both modes from different sources',
      { REVO_TEST_ACTIVATION_FAULT: 'cancel' },
      { REVO_TEST_ACTIVATION_DIAGNOSTICS: '1' },
      'activation fault and diagnostic modes cannot be combined',
    ],
    [
      'both modes with extra diagnostics override',
      { REVO_TEST_ACTIVATION_DIAGNOSTICS: '1' },
      { REVO_TEST_ACTIVATION_FAULT: 'cancel' },
      'activation fault and diagnostic modes cannot be combined',
    ],
  ] as const)('rejects %s', (_label, extra, inherited, message) => {
    expect(() => assertActivationTestModes(Object.freeze(extra), Object.freeze(inherited))).toThrow(
      message,
    );
  });

  it.each(['0', '', 'true', 'enabled'])('rejects diagnostics value %j', (value) => {
    const extra = Object.freeze({ REVO_TEST_ACTIVATION_DIAGNOSTICS: value });
    const inherited = Object.freeze({ REVO_TEST_ACTIVATION_FAULT: 'cancel' });
    expect(() => assertActivationTestModes(extra, inherited)).toThrow(
      'invalid activation diagnostic mode',
    );
    expect(extra.REVO_TEST_ACTIVATION_DIAGNOSTICS).toBe(value);
    expect(inherited.REVO_TEST_ACTIVATION_FAULT).toBe('cancel');
  });

  it('rejects extra diagnostics value before reporting a fault conflict', () => {
    expect(() =>
      assertActivationTestModes(
        Object.freeze({ REVO_TEST_ACTIVATION_DIAGNOSTICS: '0' }),
        Object.freeze({ REVO_TEST_ACTIVATION_FAULT: 'cancel' }),
      ),
    ).toThrow('invalid activation diagnostic mode');
  });
});
