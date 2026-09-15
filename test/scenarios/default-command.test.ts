// oxlint-disable-next-line import/no-unassigned-import -- decorators require this side effect first
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { CommandFactory } from 'nest-commander';
import { describe, expect, it, vi } from 'vitest';

import { cliFailure } from '../../src/cli/cli-error.js';
import { DefaultCommand } from '../../src/cli/commands/default.command.js';
import { BrowserOpenerService } from '../../src/cli/diagnostics/browser-opener.service.js';
import { OutputService } from '../../src/cli/output.service.js';
import { ServerCommandService } from '../../src/cli/server-command.service.js';
import { WebCommandService } from '../../src/cli/web-command.service.js';

type Outcome =
  | { readonly kind: 'started'; readonly url: string }
  | { readonly kind: 'running'; readonly status: { readonly phase: 'running'; publicUrl?: string } }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'unknown' };

describe('revo default command', () => {
  it.each<{ args: readonly string[]; outcome: Outcome; output: string }>([
    {
      args: [],
      outcome: { kind: 'started', url: 'https://revo.example/' },
      output: 'https://revo.example\n',
    },
    {
      args: [],
      outcome: {
        kind: 'running',
        status: { phase: 'running', publicUrl: 'http://127.0.0.1:3210' },
      },
      output: 'http://127.0.0.1:3210\n',
    },
  ])('prints only the verified URL for $outcome.kind', async ({ args, outcome, output }) => {
    const fixture = await run(args, outcome);

    expect(fixture).toMatchObject({ exitCode: 0, stderr: '', stdout: output });
    expect(fixture.ensure).toHaveBeenCalledOnce();
  });

  it('uses the running advertised URL and fails when it is unavailable', async () => {
    const fixture = await run([], { kind: 'running', status: { phase: 'running' } });

    expect(fixture).toMatchObject({
      exitCode: 1,
      stderr: 'Server is running, but its public URL is unavailable.\n',
      stdout: '',
    });
  });

  it.each([
    'https://user:secret@revo.example',
    'https://revo.example/path',
    'https://revo.example?token=x',
  ])('rejects a non-origin started URL: %s', async (url) => {
    const fixture = await run([], { kind: 'started', url });

    expect(fixture).toMatchObject({
      exitCode: 1,
      stderr: 'Server public URL is invalid.\n',
      stdout: '',
    });
  });

  it('opens only after the URL is printed and preserves exit zero on opener failure', async () => {
    const opener = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const fixture = await run(['--web'], { kind: 'started', url: 'http://revo.example' }, opener);

    expect(fixture).toMatchObject({
      exitCode: 0,
      stdout: 'http://revo.example\n',
      stderr: 'Could not open a browser; open the URL above manually.\n',
    });
    expect(opener).toHaveBeenCalledWith('http://revo.example');
    expect(fixture.events).toEqual([
      'write:http://revo.example',
      'open:http://revo.example',
      'error:Could not open a browser; open the URL above manually.',
    ]);
  });

  it.each([['--port', '3210'], ['extra']])(
    'rejects root grammar without launching: %s',
    async (...args: string[]) => {
      const fixture = await run(args, { kind: 'started', url: 'http://revo.example' });

      expect(fixture.exitCode).toBe(2);
      expect(fixture.stdout).toBe('');
      expect(fixture.ensure).not.toHaveBeenCalled();
    },
  );

  it('does not launch for help', async () => {
    const fixture = await run(['--help'], { kind: 'started', url: 'http://revo.example' });

    expect(fixture).toMatchObject({ exitCode: 0, stderr: '' });
    expect(fixture.stdout).toContain('Usage: revo');
    expect(fixture.ensure).not.toHaveBeenCalled();
  });
});

async function run(
  args: readonly string[],
  outcome: Outcome,
  open = vi.fn<(url: string) => Promise<boolean>>().mockResolvedValue(true),
): Promise<{
  readonly ensure: ReturnType<typeof vi.fn>;
  readonly events: string[];
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}> {
  const output: string[] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const ensure = vi.fn<() => Promise<Outcome>>().mockResolvedValue(outcome);
  const outputService = {
    write: (message: string) => {
      events.push(`write:${message}`);
      output.push(`${message}\n`);
    },
    writeError: (message: string) => {
      events.push(`error:${message}`);
      errors.push(`${message}\n`);
    },
  };
  const browser = {
    open: async (url: string): Promise<boolean> => {
      events.push(`open:${url}`);
      return open(url);
    },
  };

  @Module({
    providers: [
      DefaultCommand,
      WebCommandService,
      { provide: ServerCommandService, useValue: { ensureRunning: ensure } },
      { provide: BrowserOpenerService, useValue: browser },
      { provide: OutputService, useValue: outputService },
    ],
  })
  // oxlint-disable-next-line typescript/no-extraneous-class -- Nest test module metadata
  class TestModule {}

  const previousArgv = process.argv;
  process.argv = ['node', 'revo', ...args];
  let exitCode = 0;
  try {
    await CommandFactory.run(TestModule, {
      cliName: 'revo',
      errorHandler: (error) => {
        throw error;
      },
      logger: false,
      outputConfiguration: { writeErr: () => undefined, writeOut: (text) => output.push(text) },
      serviceErrorHandler: (error) => {
        throw error;
      },
    });
  } catch (error) {
    const failure = cliFailure(error);
    exitCode = failure.exitCode;
    if (failure.message !== undefined) {
      errors.push(`${failure.message}\n`);
    }
  } finally {
    process.argv = previousArgv;
  }
  return { ensure, events, exitCode, stderr: errors.join(''), stdout: output.join('') };
}
