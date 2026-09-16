import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import koffi from 'koffi';

import { acquireActivationOwnership } from '../../../dist/installation/activation-ownership.js';
import { ManagedActivationService } from '../../../dist/installation/managed-activation.service.js';
import { PosixFlockAdapter } from '../../../dist/processes/adapters/posix-flock.adapter.js';
import { ServerOwnershipService } from '../../../dist/processes/server-ownership.service.js';

const ownership = new ServerOwnershipService();
let lease;
let activationLease;
let continueGate;
let allowContinue;
let completion;

class BarrierServerOwnershipService extends ServerOwnershipService {
  async acquire(dataDir) {
    const result = await super.acquire(dataDir);
    if (result.kind === 'held') {
      await activationLease.assertHeld();
      continueGate = new Promise((resolve) => {
        allowContinue = resolve;
      });
      process.send({ phase: 'before-commit' });
      await continueGate;
    }
    return result;
  }
}

async function respond(request) {
  if (request.action === 'acquire') {
    lease = await ownership.acquire(request.dataDir);
    process.send({ kind: lease.kind });
    return;
  }
  if (request.action === 'release') {
    await lease?.release();
    process.send({ released: true });
    return;
  }
  if (request.action === 'continue-activation') {
    allowContinue?.();
    process.send({ continued: true });
    return;
  }
  if (request.action === 'wait-activation') {
    const result = await completion;
    process.send({ outcome: result.outcome });
    return;
  }
  if (request.action === 'activate-managed') {
    const acquire = async (input) => {
      const result = await acquireActivationOwnership(input);
      if (result.status === 'held') {
        activationLease = result.lease;
      }
      return result;
    };
    const service = new ManagedActivationService(
      undefined,
      new BarrierServerOwnershipService(),
      acquire,
    );
    completion = service
      .activate({
        channelRoot: request.channelRoot,
        candidate: request.candidate,
        configuration: request.configuration,
      })
      .then((outcome) => {
        process.send({ phase: 'activation-completed', outcome });
        return { outcome };
      });
    return;
  }
  if (request.action === 'identity') {
    const metadata = await stat(path.join(await realpath(request.dataDir), '.revo-server.lock'));
    process.send({ dev: String(metadata.dev), ino: String(metadata.ino) });
    return;
  }
  if (request.action === 'spawn-unrelated') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    process.send({ pid: child.pid });
    return;
  }
  if (request.action === 'probe-cloexec') {
    await mkdir(request.dataDir, { mode: 0o700, recursive: true });
    const adapter = new PosixFlockAdapter();
    const file = await open(
      path.join(await realpath(request.dataDir), '.probe.lock'),
      constants.O_CREAT | constants.O_RDWR | adapter.openFlags(process.platform),
      0o600,
    );
    try {
      const library = koffi.load(
        process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
      );
      const fcntl = library.func('int fcntl(int fd, int command)');
      process.send({ closeOnExec: (fcntl(file.fd, 1) & 1) === 1 });
    } finally {
      await file.close();
    }
  }
}

process.on('message', (request) => {
  respond(request).catch((error) => {
    process.send({ error: error instanceof Error ? error.message : String(error) });
  });
});

process.send({ ready: true, platform: process.platform, architecture: process.arch });
