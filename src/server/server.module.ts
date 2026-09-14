import { Module } from '@nestjs/common';

import { CoreHostProcessService } from '../core-host/core-host-process.service.js';
import { ProcessesModule } from '../processes/processes.module.js';
import { ServerOwnerService } from './server-owner.service.js';

@Module({
  exports: [ServerOwnerService],
  imports: [ProcessesModule],
  providers: [CoreHostProcessService, ServerOwnerService],
})
// oxlint-disable-next-line typescript/no-extraneous-class -- Nest modules are decorator metadata
export class ServerModule {}
