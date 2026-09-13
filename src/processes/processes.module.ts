import { Module } from '@nestjs/common';

import { PosixFlockAdapter } from './adapters/posix-flock.adapter.js';
import { ManagedProcessService } from './managed-process.service.js';
import { ProcessExitWaiter } from './process-exit-waiter.js';
import { ServerOwnershipService } from './server-ownership.service.js';

@Module({
  exports: [ManagedProcessService, ServerOwnershipService],
  providers: [ManagedProcessService, PosixFlockAdapter, ProcessExitWaiter, ServerOwnershipService],
})
// oxlint-disable-next-line typescript/no-extraneous-class -- Nest modules are decorator metadata
export class ProcessesModule {}
