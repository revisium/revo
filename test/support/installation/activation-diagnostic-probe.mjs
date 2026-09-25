// oxlint-disable curly -- test-only observer keeps event records fixed and bounded
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_RECORDS = 16;
const MAX_BYTES = 2 * 1024;
const PREFIX = 'REVO_ACTIVATION_DIAG v=1';
const TRUNCATED = `${PREFIX} phase=probe event=truncated`;
let records = 0;
let bytes = 0;
let stopped = false;
let incomplete = false;

function writeIncompleteBestEffort() {
  const line = `${PREFIX} phase=probe event=incomplete`;
  const lineBytes = Buffer.byteLength(`${line}\n`);
  if (records >= MAX_RECORDS || bytes + lineBytes > MAX_BYTES) return;
  records += 1;
  bytes += lineBytes;
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // The original activation outcome takes precedence over diagnostic output.
  }
}

function writeRecord(phase, event, fields = '') {
  if (stopped || incomplete) return;
  const line = `${PREFIX} phase=${phase} event=${event}${fields ? ` ${fields}` : ''}`;
  const lineBytes = Buffer.byteLength(`${line}\n`);
  if (
    records >= MAX_RECORDS - 1 ||
    bytes + lineBytes + Buffer.byteLength(`${TRUNCATED}\n`) > MAX_BYTES
  ) {
    process.stderr.write(`${TRUNCATED}\n`);
    records += 1;
    stopped = true;
    return;
  }
  if (!process.stderr.write(`${line}\n`)) {
    throw new Error('diagnostic output unavailable');
  }
  records += 1;
  bytes += lineBytes;
}

function safeWriteRecord(phase, event, fields = '') {
  try {
    writeRecord(phase, event, fields);
  } catch {
    if (!incomplete) {
      incomplete = true;
      stopped = true;
      writeIncompleteBestEffort();
    }
  }
}

function statusField(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : 'other';
}

function asyncWrapper(original, phase, resultFields) {
  return function (...args) {
    safeWriteRecord(phase, 'enter');
    let result;
    try {
      result = Reflect.apply(original, this, args);
    } catch (error) {
      safeWriteRecord(phase, 'throw');
      throw error;
    }
    return Promise.resolve(result).then(
      (value) => {
        let fields = '';
        try {
          fields = resultFields(value);
        } catch {
          fields = 'status=other';
        }
        safeWriteRecord(phase, 'return', fields);
        return value;
      },
      (error) => {
        safeWriteRecord(phase, 'throw');
        throw error;
      },
    );
  };
}

function syncAdmissionWrapper(original) {
  return function (...args) {
    safeWriteRecord(
      'activation-admission',
      'enter',
      `status=${statusField(args[0], ['busy', 'cancelled', 'unavailable'])}`,
    );
    try {
      const result = Reflect.apply(original, this, args);
      safeWriteRecord('activation-admission', 'return');
      return result;
    } catch (error) {
      safeWriteRecord('activation-admission', 'throw');
      throw error;
    }
  };
}

async function installObservers() {
  const helper = process.argv[1];
  if (typeof helper !== 'string') throw new Error('helper path unavailable');
  const directory = dirname(resolve(helper));
  const [managed, configuration, ownership] = await Promise.all([
    import(pathToFileURL(resolve(directory, '../installation/managed-activation.service.js')).href),
    import(pathToFileURL(resolve(directory, '../configuration/configuration-resolver.js')).href),
    import(pathToFileURL(resolve(directory, '../processes/server-ownership.service.js')).href),
  ]);

  const targets = [
    {
      prototype: managed.ManagedActivationService.prototype,
      method: 'activate',
      wrap: (original) =>
        asyncWrapper(original, 'managed', (value) => {
          let status = 'other';
          let generationValid = false;
          if (value && typeof value === 'object') {
            status = statusField(value.status, [
              'activated',
              'unchanged',
              'busy',
              'cancelled',
              'outcome-unknown',
              'server-busy',
              'unavailable',
            ]);
            generationValid =
              typeof value.generationId === 'string' && /^[a-f0-9]{64}$/u.test(value.generationId);
          }
          return `status=${status} generationValid=${generationValid}`;
        }),
    },
    {
      prototype: managed.ManagedActivationService.prototype,
      method: 'admissionOutcome',
      wrap: syncAdmissionWrapper,
    },
    {
      prototype: managed.ManagedActivationService.prototype,
      method: 'performActivation',
      wrap: (original) =>
        asyncWrapper(
          original,
          'perform-activation',
          (value) =>
            `status=${statusField(value?.outcome?.status, [
              'activated',
              'unchanged',
              'busy',
              'cancelled',
              'outcome-unknown',
              'server-busy',
              'unavailable',
            ])}`,
        ),
    },
    {
      prototype: configuration.ConfigurationResolver.prototype,
      method: 'resolve',
      wrap: (original) => asyncWrapper(original, 'configuration', () => ''),
    },
    {
      prototype: ownership.ServerOwnershipService.prototype,
      method: 'acquire',
      wrap: (original) =>
        asyncWrapper(
          original,
          'server-ownership',
          (value) =>
            `status=${statusField(value?.kind, ['held', 'busy', 'missing', 'unavailable'])}`,
        ),
    },
  ];

  const prepared = targets.map((target) => {
    const descriptor = Object.getOwnPropertyDescriptor(target.prototype, target.method);
    if (
      !descriptor ||
      typeof descriptor.value !== 'function' ||
      descriptor.writable !== true ||
      descriptor.configurable !== true
    ) {
      throw new Error('observer target unavailable');
    }
    return { ...target, descriptor };
  });

  const installed = [];
  try {
    for (const target of prepared) {
      Object.defineProperty(target.prototype, target.method, {
        ...target.descriptor,
        value: target.wrap(target.descriptor.value),
      });
      installed.push(target);
    }
  } catch {
    for (const target of installed.reverse()) {
      try {
        Object.defineProperty(target.prototype, target.method, target.descriptor);
      } catch {
        // Keep attempting descriptor restoration without exposing observer errors.
      }
    }
    throw new Error('observer setup failed');
  }
}

try {
  await installObservers();
  safeWriteRecord('probe', 'ready');
} catch {
  safeWriteRecord('probe', 'incomplete');
}
