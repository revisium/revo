import { describe, expect, it, vi } from 'vitest';

import { runFoundationCli } from '../src/foundation-cli.js';

describe('runFoundationCli', () => {
  it('prints the package version', () => {
    const output = {
      error: vi.fn<(message: string) => void>(),
      log: vi.fn<(message: string) => void>(),
    };

    expect(runFoundationCli(['--version'], '1.2.3', output)).toBe(0);
    expect(output.log).toHaveBeenCalledWith('1.2.3');
    expect(output.error).not.toHaveBeenCalled();
  });

  it.each([
    { args: [] },
    { args: ['status'] },
    { args: ['--help'] },
    { args: ['--version', 'status'] },
  ])('rejects unsupported foundation arguments: %j', ({ args }) => {
    const output = {
      error: vi.fn<(message: string) => void>(),
      log: vi.fn<(message: string) => void>(),
    };

    expect(runFoundationCli(args, '1.2.3', output)).toBe(1);
    expect(output.error).toHaveBeenCalledWith(
      'This placeholder Revo adapter only supports --version. Product commands require revo-cli integration.',
    );
    expect(output.log).not.toHaveBeenCalled();
  });
});
