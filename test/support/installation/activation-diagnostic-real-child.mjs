import { constants } from 'node:fs';
import { readFile } from 'node:fs/promises';

const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const [{ ManagedActivationService }, { ConfigurationResolver }, { ServerOwnershipService }, store] =
  await Promise.all([
    import('../installation/managed-activation.service.js'),
    import('../configuration/configuration-resolver.js'),
    import('../processes/server-ownership.service.js'),
    import('../installation/activation-store.js'),
  ]);

const mode = input.mode;
const counters = {
  admission: 0,
  activationRelease: 0,
  assertHeld: 0,
  serverLock: 0,
  serverUnlock: 0,
};
const candidate = input.candidate;
if (mode === 'channel-mismatch') {
  candidate.plan.release.channel = 'alpha';
}
if (mode === 'invalid-candidate') {
  candidate.nodeArchiveSha256 = 'f'.repeat(64);
}

const nativeLock = {
  descriptor: -1,
  unlock() {
    counters.serverUnlock += 1;
    if (mode === 'cleanup-failure') {
      throw new Error('test-only server release failure');
    }
  },
};
const nativeAdapter = {
  openFlags: () => constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
  async lock(file) {
    counters.serverLock += 1;
    nativeLock.descriptor = file.fd;
    return nativeLock;
  },
};
const server = new ServerOwnershipService(nativeAdapter);
const expectedConfigurationError = new Error('test-only configuration failure');
const configuration = new ConfigurationResolver(
  mode === 'configuration-error'
    ? { read: async () => Promise.reject(expectedConfigurationError) }
    : undefined,
);

const acquireOwnership = async () => {
  counters.admission += 1;
  if (mode.startsWith('admission-')) {
    return { status: mode.slice('admission-'.length) };
  }
  return {
    status: 'held',
    lease: {
      async assertHeld() {
        counters.assertHeld += 1;
      },
      async release() {
        counters.activationRelease += 1;
        if (mode === 'cleanup-failure') {
          throw new Error('test-only activation release failure');
        }
      },
    },
  };
};

const service = new ManagedActivationService(configuration, server, acquireOwnership);
let result;
let configurationErrorIdentity = false;
try {
  result = await service.activate({
    channelRoot: input.channelRoot,
    candidate,
    configuration: input.configuration,
  });
} catch (error) {
  configurationErrorIdentity = error === expectedConfigurationError;
  if (!configurationErrorIdentity) {
    throw error;
  }
}

const current = await store.readActivation(input.channelRoot);
const summary = {
  configurationErrorIdentity,
  counters,
  current: current.status,
  currentGenerationValid:
    current.status === 'valid' && /^[a-f0-9]{64}$/u.test(current.record.generationId),
  result: result?.status ?? 'threw',
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
