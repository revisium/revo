import { Module } from '@nestjs/common';

import { CoreHostProcessService } from '../core-host/core-host-process.service.js';
import { ProcessesModule } from '../processes/processes.module.js';
import { ServerOwnerService } from './server-owner.service.js';
import { ServerStatusService } from './server-status.service.js';
import { ServerStopService } from './server-stop.service.js';

@Module({
  exports: [ServerOwnerService, ServerStatusService, ServerStopService],
  imports: [ProcessesModule],
  providers: [CoreHostProcessService, ServerOwnerService, ServerStatusService, ServerStopService],
})
// oxlint-disable-next-line typescript/no-extraneous-class -- Nest modules are decorator metadata
export class ServerModule {}
