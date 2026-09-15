import { CommandFactory } from 'nest-commander';

import { cliFailure } from './cli-error.js';
import { CliModule } from './cli.module.js';
import { OutputService } from './output.service.js';
import { PackageMetadataService } from './package-metadata.service.js';

export class CliBootstrapService {
  constructor(
    private readonly metadata: PackageMetadataService,
    private readonly output: OutputService,
  ) {}

  async run(): Promise<number> {
    try {
      await CommandFactory.run(CliModule, {
        cliName: this.metadata.cliName,
        errorHandler: (error) => {
          throw error;
        },
        logger: false,
        outputConfiguration: {
          writeErr: () => undefined,
        },
        serviceErrorHandler: async (error) => {
          throw error;
        },
        version: this.metadata.version,
      });
    } catch (error) {
      const failure = cliFailure(error);
      if (failure.message !== undefined) {
        this.output.writeError(failure.message);
      }

      return failure.exitCode;
    }

    return 0;
  }
}
