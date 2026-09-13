import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliScenario } from '../support/cli/cli-scenario.js';

describe('Revo CLI', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([{ args: [] }, { args: ['--help'] }, { args: ['-h'] }])(
    'prints product help for $args',
    async ({ args }) => {
      const result = await CliScenario.run(args);

      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).toContain('Usage: revo');
      expect(result.stdout).toContain('version');
      expect(result.stderr).toBe('');
    },
  );

  it.each([{ args: ['--version'] }, { args: ['-V'] }])(
    'prints package metadata for $args',
    async ({ args }) => {
      const result = await CliScenario.run(args);

      expect(result).toMatchObject({ exitCode: 0, signal: null, stderr: '', stdout: '0.0.0\n' });
    },
  );

  it('runs the compiled version command through Nest dependency injection', async () => {
    const result = await CliScenario.run(['version']);

    expect(result).toMatchObject({ exitCode: 0, signal: null, stderr: '', stdout: '0.0.0\n' });
  });

  it.each([
    { args: ['unknown'], error: "error: unknown command 'unknown'\n" },
    { args: ['--unknown'], error: "error: unknown option '--unknown'\n" },
  ])('rejects invalid input $args without framework noise', async ({ args, error }) => {
    const result = await CliScenario.run(args);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(error);
    expect(result.stderr).not.toMatch(/\n\s+at |NestFactory|\[Nest\]/i);
  });

  it('injects replaced package metadata in a real Nest application context', async () => {
    const output = await CliScenario.runVersionWithMetadata('9.8.7');

    expect(output).toBe('9.8.7\n');
  });

  it('closes real Nest application contexts across normal and handled exits', async () => {
    const version = await CliScenario.runInApplication(['version']);
    const help = await CliScenario.runInApplication(['--help']);
    const invalid = await CliScenario.runInApplication(['unknown']);

    expect(version).toMatchObject({ exitCode: 0, stderr: '', stdout: '0.0.0\n' });
    expect(help).toMatchObject({ exitCode: 0, stderr: '' });
    expect(help.stdout).toContain('Usage: revo');
    expect(invalid).toMatchObject({ exitCode: 2, stdout: '' });
    expect(invalid.stderr).toContain("unknown command 'unknown'");
  });

  it.each([
    { failure: new Error('startup failed'), stderr: 'startup failed\n' },
    { failure: 'startup rejected', stderr: 'startup rejected\n' },
    { failure: new Error('already terminated\n'), stderr: 'already terminated\n' },
  ])('reports an application startup failure once: $stderr', async ({ failure, stderr }) => {
    const result = await CliScenario.failApplicationWith(failure);

    expect(result).toMatchObject({ exitCode: 1, stdout: '', stderr });
  });
});
