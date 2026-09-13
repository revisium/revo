import { Module } from '@nestjs/common';

import { PosixFlockAdapter } from './adapters/posix-flock.adapter.js';
import { ServerOwnershipService } from './server-ownership.service.js';

@Module({
  exports: [ServerOwnershipService],
  providers: [PosixFlockAdapter, ServerOwnershipService],
})
// oxlint-disable-next-line typescript/no-extraneous-class -- Nest modules are decorator metadata
export class ProcessesModule {}
