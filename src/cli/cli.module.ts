import { Module } from '@nestjs/common';

import { VersionCommand } from './commands/version.command.js';
import { OutputService } from './output.service.js';
import { PackageMetadataService } from './package-metadata.service.js';

@Module({
  providers: [OutputService, PackageMetadataService, VersionCommand],
})
// oxlint-disable-next-line typescript/no-extraneous-class -- Nest modules are decorator metadata
export class CliModule {}
