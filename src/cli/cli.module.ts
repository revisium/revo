import { Module } from '@nestjs/common';

import { ConfigurationResolver } from '../configuration/configuration-resolver.js';
import { ServerModule } from '../server/server.module.js';
import { ServerCommand } from './commands/server.command.js';
import { VersionCommand } from './commands/version.command.js';
import { OutputService } from './output.service.js';
import { PackageMetadataService } from './package-metadata.service.js';
import { ServerCommandService } from './server-command.service.js';

@Module({
  imports: [ServerModule],
  providers: [
    ConfigurationResolver,
    OutputService,
    PackageMetadataService,
    ServerCommandService,
    VersionCommand,
    ...ServerCommand.registerWithSubCommands(),
  ],
})
// oxlint-disable-next-line typescript/no-extraneous-class -- Nest modules are decorator metadata
export class CliModule {}
