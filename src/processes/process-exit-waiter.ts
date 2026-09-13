import { Injectable } from '@nestjs/common';

import type { ProcessCompletion } from './managed-process.types.js';

@Injectable()
export class ProcessExitWaiter {
  async wait(completion: Promise<ProcessCompletion>, milliseconds: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        completion.then(() => true),
        new Promise<boolean>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(false), milliseconds);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
