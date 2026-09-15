import { Module } from '@nestjs/common';

import { ConfigurationResolver } from '../configuration/configuration-resolver.js';
import { ServerModule } from '../server/server.module.js';
import { DefaultCommand } from './commands/default.command.js';
import { ServerCommand } from './commands/server.command.js';
import { VersionCommand } from './commands/version.command.js';
import { BrowserOpenerService } from './diagnostics/browser-opener.service.js';
import { OutputService } from './output.service.js';
import { PackageMetadataService } from './package-metadata.service.js';
import { ServerCommandService } from './server-command.service.js';
import { WebCommandService } from './web-command.service.js';

@Module({
  imports: [ServerModule],
  providers: [
    ConfigurationResolver,
    BrowserOpenerService,
    OutputService,
    PackageMetadataService,
    ServerCommandService,
    WebCommandService,
    DefaultCommand,
    VersionCommand,
    ...ServerCommand.registerWithSubCommands(),
  ],
})
// oxlint-disable-next-line typescript/no-extraneous-class -- Nest modules are decorator metadata
export class CliModule {}
