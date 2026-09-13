// oxlint-disable-next-line import/no-unassigned-import -- decorators require this side effect first
import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { vi } from 'vitest';

import { CliBootstrapService } from '../../../src/cli/cli-bootstrap.service.js';
import { VersionCommand } from '../../../src/cli/commands/version.command.js';
import { OutputService } from '../../../src/cli/output.service.js';
import { PackageMetadataService } from '../../../src/cli/package-metadata.service.js';

export interface CliResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BUILT_CLI = resolve(REPOSITORY_ROOT, 'dist/bin/revo.js');

export class CliScenario {
  private constructor() {}

  static async run(args: readonly string[]): Promise<CliResult> {
    const unrelatedDirectory = await mkdtemp(`${tmpdir()}/revo-cli-`);
    try {
      const result = spawnSync(process.execPath, [BUILT_CLI, ...args], {
        cwd: unrelatedDirectory,
        encoding: 'utf8',
        input: '',
        timeout: 2_000,
      });

      if (result.error !== undefined) {
        throw result.error;
      }

      return {
        exitCode: result.status,
        signal: result.signal,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    } finally {
      await rm(unrelatedDirectory, { recursive: true });
    }
  }

  static async runInApplication(args: readonly string[]): Promise<CliResult> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const previousArgv = process.argv;
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    process.argv = ['node', 'revo', ...args];
    try {
      const bootstrap = new CliBootstrapService(new PackageMetadataService(), new OutputService());
      const exitCode = await bootstrap.run();

      return { exitCode, signal: null, stderr: stderr.join(''), stdout: stdout.join('') };
    } finally {
      process.argv = previousArgv;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  }

  static async runVersionWithMetadata(version: string): Promise<string> {
    @Module({
      providers: [
        VersionCommand,
        OutputService,
        {
          provide: PackageMetadataService,
          useValue: { cliName: 'fixture-revo', version },
        },
      ],
    })
    // oxlint-disable-next-line typescript/no-extraneous-class -- Nest test module metadata
    class TestCliModule {}

    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const application = await NestFactory.createApplicationContext(TestCliModule, {
      logger: false,
    });
    try {
      await application.get(VersionCommand).run();
    } finally {
      await application.close();
    }

    return writes.join('');
  }
}
