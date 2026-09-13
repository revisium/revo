import { Module } from '@nestjs/common';

import { DarwinProcessIdentityAdapter } from './adapters/darwin-process-identity.adapter.js';
import { LinuxProcessIdentityAdapter } from './adapters/linux-process-identity.adapter.js';
import { PosixFlockAdapter } from './adapters/posix-flock.adapter.js';
import { ManagedProcessService } from './managed-process.service.js';
import { ProcessExitWaiter } from './process-exit-waiter.js';
import { PROCESS_IDENTITY_PLATFORM, ProcessIdentityService } from './process-identity.service.js';
import { ServerOwnershipService } from './server-ownership.service.js';

@Module({
  exports: [ManagedProcessService, ProcessIdentityService, ServerOwnershipService],
  providers: [
    DarwinProcessIdentityAdapter,
    LinuxProcessIdentityAdapter,
    ManagedProcessService,
    PosixFlockAdapter,
    ProcessExitWaiter,
    ProcessIdentityService,
    ServerOwnershipService,
    { provide: PROCESS_IDENTITY_PLATFORM, useValue: process.platform },
  ],
})
// oxlint-disable-next-line typescript/no-extraneous-class -- Nest modules are decorator metadata
export class ProcessesModule {}
