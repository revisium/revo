import { Module } from '@nestjs/common';

import { ConfigurationResolver } from '../configuration/configuration-resolver.js';
import { CoreHostProcessService } from '../core-host/core-host-process.service.js';
import { ManagedProcessService } from '../processes/managed-process.service.js';
import { ProcessesModule } from '../processes/processes.module.js';
import { StartupProgressDiscoveryService } from '../startup-progress/index.js';
import { ServerLaunchProcessService } from './server-launch-process.service.js';
import { ServerLauncherService } from './server-launcher.service.js';
import { ServerOwnerService } from './server-owner.service.js';
import { ServerStartupObserver } from './server-startup-observer.js';
import { ServerStatusService } from './server-status.service.js';
import { ServerStopService } from './server-stop.service.js';

@Module({
  exports: [ServerLauncherService, ServerOwnerService, ServerStatusService, ServerStopService],
  imports: [ProcessesModule],
  providers: [
    ConfigurationResolver,
    CoreHostProcessService,
    ServerLauncherService,
    ServerOwnerService,
    ServerStatusService,
    ServerStopService,
    ServerStartupObserver,
    StartupProgressDiscoveryService,
    {
      provide: ServerLaunchProcessService,
      useFactory: (processes: ManagedProcessService) => new ServerLaunchProcessService(processes),
      inject: [ManagedProcessService],
    },
  ],
})
// oxlint-disable-next-line typescript/no-extraneous-class -- Nest modules are decorator metadata
export class ServerModule {}
