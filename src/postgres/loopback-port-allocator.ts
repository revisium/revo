import { createServer, type Server } from 'node:net';

import { Injectable } from '@nestjs/common';

import { EmbeddedPostgresError } from './embedded-postgres.types.js';

export interface ReservedLoopbackPort {
  readonly port: number;
  release(): Promise<void>;
}

@Injectable()
export class LoopbackPortAllocator {
  reserve(): Promise<ReservedLoopbackPort> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', () => reject(new EmbeddedPostgresError('process')));
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new EmbeddedPostgresError('process'));
          return;
        }
        resolve({ port: address.port, release: () => close(server) });
      });
    });
  }
}

const close = (server: Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(new EmbeddedPostgresError('process')) : resolve())),
  );
