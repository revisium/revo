import { readFile } from 'node:fs/promises';

import { ConfigurationError } from './configuration-error.js';

export class ConfigFileLoader {
  async read(path: string, explicit: boolean): Promise<unknown> {
    let source: string;
    try {
      source = await readFile(path, 'utf8');
    } catch (error) {
      if (!explicit && this.errorCode(error) === 'ENOENT') {
        return undefined;
      }
      throw new ConfigurationError({
        code: 'revo.configuration.file',
        exitCode: 1,
        field: 'config',
        message: 'Unable to read the configuration file.',
        source: 'config-file',
        cause: error,
      });
    }

    try {
      return JSON.parse(source);
    } catch {
      throw new ConfigurationError({
        code: 'revo.configuration.invalid',
        exitCode: 2,
        field: 'config',
        message: 'Invalid configuration file JSON.',
        source: 'config-file',
      });
    }
  }

  private errorCode(error: unknown): unknown {
    return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  }
}
