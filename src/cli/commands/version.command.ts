import { Command, CommandRunner } from 'nest-commander';

import { OutputService } from '../output.service.js';
import { PackageMetadataService } from '../package-metadata.service.js';

@Command({
  name: 'version',
  description: 'Print the package version',
})
export class VersionCommand extends CommandRunner {
  constructor(
    private readonly metadata: PackageMetadataService,
    private readonly output: OutputService,
  ) {
    super();
  }

  async run(): Promise<void> {
    this.output.write(this.metadata.version);
  }
}
