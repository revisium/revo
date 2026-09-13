import { describe, expect, it, vi } from 'vitest';

import { cliFailure } from '../../src/cli/cli-error.js';
import { OutputService } from '../../src/cli/output.service.js';

describe('CLI support services', () => {
  it('maps commander input errors to exit code 2', () => {
    expect(cliFailure(Object.assign(new Error('bad option'), { code: 'commander.invalidArgument' }))).toEqual({
      exitCode: 2,
      message: 'bad option',
    });
  });

  it('maps clean commander exits to success without output', () => {
    expect(cliFailure({ exitCode: 0 })).toEqual({ exitCode: 0 });
  });

  it('maps operational and non-error failures to exit code 1', () => {
    expect(cliFailure(new Error('startup failed'))).toEqual({ exitCode: 1, message: 'startup failed' });
    expect(cliFailure('unknown failure')).toEqual({ exitCode: 1, message: 'unknown failure' });
    expect(cliFailure(null)).toEqual({ exitCode: 1, message: 'null' });
  });

  it('writes exactly one line while preserving an existing newline', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const output = new OutputService();

    output.write('ready');
    output.writeError('failed\n');

    expect(stdout).toHaveBeenCalledWith('ready\n');
    expect(stderr).toHaveBeenCalledWith('failed\n');
    stdout.mockRestore();
    stderr.mockRestore();
  });
});
