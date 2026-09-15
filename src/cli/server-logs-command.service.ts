import { homedir } from 'node:os';
import process from 'node:process';

import { Inject, Injectable } from '@nestjs/common';

import { ConfigurationResolver } from '../configuration/configuration-resolver.js';
import type { ConfigurationFlags } from '../configuration/configuration.types.js';
import { follow, waitForFollowPoll } from '../server-logs/follow.js';
import {
  ServerLifecycleReader,
  type ServerLifecycleReadResult,
} from '../server-logs/reader.service.js';
import { OutputService } from './output.service.js';
import { PackageMetadataService } from './package-metadata.service.js';

export const SERVER_LOGS_WAIT = Symbol('SERVER_LOGS_WAIT');

export interface ServerLogsFlags extends ConfigurationFlags {
  readonly follow?: boolean;
}

export type ServerLogsWait = (signal: AbortSignal) => Promise<void>;

export class ServerLogsError extends Error {
  readonly code = 'revo.server-logs.invalid';

  constructor() {
    super('Server lifecycle logs are unavailable or unsafe.');
    this.name = 'ServerLogsError';
  }
}

class ServerLogsSignalError extends Error {
  readonly code = 'revo.server-logs.signal';

  constructor(readonly exitCode: 130 | 143) {
    super('');
    this.name = 'ServerLogsSignalError';
  }
}

@Injectable()
export class ServerLogsCommandService {
  constructor(
    @Inject(ConfigurationResolver)
    private readonly configuration: Pick<ConfigurationResolver, 'resolve'>,
    @Inject(PackageMetadataService)
    private readonly metadata: Pick<PackageMetadataService, 'version'>,
    @Inject(OutputService)
    private readonly output: Pick<OutputService, 'write'>,
    @Inject(SERVER_LOGS_WAIT)
    private readonly wait: ServerLogsWait = waitForFollowPoll,
  ) {}

  async logs(flags: Readonly<ServerLogsFlags>): Promise<void> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error('Server commands are unsupported on this platform.');
    }
    const configuration = await this.configuration.resolve({
      env: { ...process.env },
      flags: this.configurationFlags(flags),
      homeDir: homedir(),
      packageVersion: this.metadata.version,
      platform: process.platform,
    });
    const reader = await ServerLifecycleReader.open({
      channel: configuration.channel,
      canonicalDataDir: configuration.layout.dataDir,
      logDir: configuration.logDir,
    });
    const controller = new AbortController();
    let exitCode: 130 | 143 | undefined;
    const abort = (code: 130 | 143) => {
      exitCode = code;
      controller.abort();
    };
    const onInterrupt = () => abort(130);
    const onTerminate = () => abort(143);
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    try {
      if (!flags.follow) {
        const result = await reader.read();
        this.handleSnapshot(result, true);
      } else {
        await follow({
          read: (cursor) => reader.read(cursor),
          wait: this.wait,
          signal: controller.signal,
          onSnapshot: (result) => this.handleSnapshot(result, false),
        });
      }
      if (exitCode !== undefined) {
        throw new ServerLogsSignalError(exitCode);
      }
    } finally {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    }
  }

  private configurationFlags(flags: Readonly<ServerLogsFlags>): Readonly<ConfigurationFlags> {
    const { channel, config, dataDir, logDir } = flags;
    return {
      ...(channel === undefined ? {} : { channel }),
      ...(config === undefined ? {} : { config }),
      ...(dataDir === undefined ? {} : { dataDir }),
      ...(logDir === undefined ? {} : { logDir }),
    };
  }

  private handleSnapshot(result: ServerLifecycleReadResult, reportMissing: boolean): void {
    if (result.kind === 'invalid') {
      throw new ServerLogsError();
    }
    if (result.kind === 'ready') {
      this.write(result);
      if (reportMissing && result.events.length === 0) {
        this.output.write('No server lifecycle logs found.');
      }
      return;
    }
    if (reportMissing) {
      this.output.write('No server lifecycle logs found.');
    }
  }

  private write(result: Extract<ServerLifecycleReadResult, { kind: 'ready' }>): void {
    for (const event of result.events) {
      this.output.write(
        `${String(event.sequence)} ${String(event.time)} ${event.phase} ${event.state} ${event.code}`,
      );
    }
  }
}
