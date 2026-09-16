import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  rename,
  realpath,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { PosixFlockAdapter, type NativeLock } from '../processes/adapters/posix-flock.adapter.js';
import { ProcessIdentityService } from '../processes/process-identity.service.js';
import type { ProcessIdentityInspection } from '../processes/process-identity.types.js';
import {
  ACTIVATION_OWNER_LIMIT,
  ACTIVATION_OWNER_SCHEMA,
  type ActivationOwnerRecord,
  parseActivationOwnerRecord,
} from './activation-owner-record.js';
import type { ActivationLease } from './activation-store.js';

const LOCK_FILE = '.activation.lock';
const OWNER_FILE = '.activation-owner.json';
const CHANNELS = new Set(['stable', 'alpha']);
const mode = (value: { readonly mode: number | bigint }): number =>
  typeof value.mode === 'bigint' ? Number(value.mode & 0o777n) : value.mode & 0o777;
const uid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;
const ownUid = (value: bigint): boolean => {
  const current = uid();
  return current === undefined || BigInt(current) === value;
};
const unavailable = (reason = 'activation ownership unavailable'): OwnershipUnavailable => ({
  status: 'unavailable',
  reason,
});

export interface HeldActivationLease extends ActivationLease {
  readonly release: () => Promise<void>;
}
export type ActivationOwnership =
  | { readonly status: 'held'; readonly lease: HeldActivationLease }
  | { readonly status: 'busy' }
  | { readonly status: 'cancelled' }
  | OwnershipUnavailable;
interface OwnershipUnavailable {
  readonly status: 'unavailable';
  readonly reason: string;
}
interface LockIdentity {
  readonly dev: string;
  readonly ino: string;
}
interface LeaseContext {
  readonly root: string;
  readonly lockPath: string;
  readonly ownerPath: string;
  readonly file: FileHandle;
  readonly native: NativeLock;
  readonly record: ActivationOwnerRecord;
  readonly lock: LockIdentity;
  readonly identity: ProcessIdentityService;
  readonly signal?: AbortSignal;
}
type ClaimContext = Omit<LeaseContext, 'record'> & { readonly channel: 'stable' | 'alpha' };
type OwnerRead =
  | { readonly status: 'absent' }
  | { readonly status: 'valid'; readonly record: ActivationOwnerRecord }
  | { readonly status: 'unavailable' };

function validRootInput(channelRoot: string, channel: string): boolean {
  return (
    typeof channelRoot === 'string' &&
    isAbsolute(channelRoot) &&
    !channelRoot.includes('\0') &&
    CHANNELS.has(channel)
  );
}

async function privateDirectory(channelRoot: string): Promise<string | undefined> {
  try {
    const root = await realpath(resolve(channelRoot));
    const value = await lstat(root, { bigint: true });
    if (
      !value.isDirectory() ||
      value.isSymbolicLink() ||
      !ownUid(value.uid) ||
      mode(value) !== 0o700
    ) {
      return undefined;
    }
    return root;
  } catch {
    return undefined;
  }
}

async function safeLock(file: FileHandle, lockPath: string): Promise<LockIdentity> {
  const descriptor = await file.stat({ bigint: true });
  const pathname = await lstat(lockPath, { bigint: true });
  if (
    !descriptor.isFile() ||
    descriptor.isSymbolicLink() ||
    descriptor.nlink !== 1n ||
    mode(descriptor) !== 0o600 ||
    !ownUid(descriptor.uid) ||
    !pathname.isFile() ||
    pathname.isSymbolicLink() ||
    pathname.nlink !== 1n ||
    mode(pathname) !== 0o600 ||
    !ownUid(pathname.uid) ||
    descriptor.dev !== pathname.dev ||
    descriptor.ino !== pathname.ino
  ) {
    throw new Error('unsafe lock');
  }
  return { dev: descriptor.dev.toString(), ino: descriptor.ino.toString() };
}

async function readOwner(ownerPath: string): Promise<OwnerRead> {
  let file: FileHandle | undefined;
  try {
    const value = await lstat(ownerPath, { bigint: true });
    if (
      !value.isFile() ||
      value.isSymbolicLink() ||
      value.nlink !== 1n ||
      mode(value) !== 0o600 ||
      !ownUid(value.uid)
    ) {
      return { status: 'unavailable' };
    }
    file = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const buffer = Buffer.alloc(ACTIVATION_OWNER_LIMIT + 1);
    const bytesRead = await readOwnerBytes(file, buffer);
    if (bytesRead > ACTIVATION_OWNER_LIMIT || !(await safeOwner(file, ownerPath))) {
      return { status: 'unavailable' };
    }
    const parsed = parseActivationOwnerRecord(
      JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')),
    );
    return parsed === undefined ? { status: 'unavailable' } : { status: 'valid', record: parsed };
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { status: 'absent' } : { status: 'unavailable' };
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function readOwnerBytes(file: FileHandle, buffer: Buffer, offset = 0): Promise<number> {
  const result = await file.read(buffer, offset, buffer.length - offset, null);
  const next = offset + result.bytesRead;
  if (result.bytesRead === 0 || next === buffer.length) {
    return next;
  }
  return readOwnerBytes(file, buffer, next);
}

async function safeOwner(file: FileHandle, ownerPath: string): Promise<boolean> {
  const descriptor = await file.stat({ bigint: true });
  const pathname = await lstat(ownerPath, { bigint: true });
  return (
    descriptor.isFile() &&
    !descriptor.isSymbolicLink() &&
    descriptor.nlink === 1n &&
    mode(descriptor) === 0o600 &&
    ownUid(descriptor.uid) &&
    pathname.isFile() &&
    !pathname.isSymbolicLink() &&
    pathname.nlink === 1n &&
    mode(pathname) === 0o600 &&
    ownUid(pathname.uid) &&
    descriptor.dev === pathname.dev &&
    descriptor.ino === pathname.ino
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(Reflect.get(error, 'code'))
    : undefined;
}

async function syncFile(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function closeLock(file: FileHandle, native: NativeLock): Promise<void> {
  let failure: unknown;
  try {
    native.unlock();
  } catch (error) {
    failure = error;
  }
  try {
    await file.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    throw new Error('activation ownership cleanup failed');
  }
}

function equalRecord(left: ActivationOwnerRecord, right: ActivationOwnerRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function identityState(
  identity: ProcessIdentityService,
  record: ActivationOwnerRecord,
): Promise<ProcessIdentityInspection> {
  try {
    return await identity.inspect(record.process);
  } catch {
    return { kind: 'unknown', reason: 'unavailable' };
  }
}

async function writeOwner(root: string, record: ActivationOwnerRecord): Promise<void> {
  const ownerPath = join(root, OWNER_FILE);
  const temporary = join(root, `.${OWNER_FILE}.${record.token}.tmp`);
  let created = false;
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    created = true;
    await syncFile(temporary);
    await rename(temporary, ownerPath);
    await syncDirectory(root);
  } catch {
    if (created) {
      // O_EXCL creation and the record token prove this private path is ours.
      await unlink(temporary).catch(() => undefined);
    }
    throw new Error('activation owner write failed');
  }
}

function recordFor(
  channel: 'stable' | 'alpha',
  process: ActivationOwnerRecord['process'],
  lock: LockIdentity,
): ActivationOwnerRecord {
  return {
    schemaVersion: ACTIVATION_OWNER_SCHEMA,
    channel,
    token: randomBytes(32).toString('hex'),
    process,
    lock,
  };
}

async function assertLock(
  file: FileHandle,
  lockPath: string,
  expected: LockIdentity,
): Promise<void> {
  const current = await safeLock(file, lockPath);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error('lock changed');
  }
}

async function lockStillOwned(
  file: FileHandle,
  lockPath: string,
  expected: LockIdentity,
): Promise<boolean> {
  try {
    await assertLock(file, lockPath, expected);
    return true;
  } catch {
    return false;
  }
}

async function cleanupClaim(
  context: ClaimContext,
  record: ActivationOwnerRecord,
): Promise<boolean> {
  try {
    await assertLock(context.file, context.lockPath, context.lock);
    const current = await readOwner(context.ownerPath);
    if (current.status === 'absent') {
      return true;
    }
    if (current.status !== 'valid' || !equalRecord(current.record, record)) {
      return false;
    }
    await unlink(context.ownerPath);
    await syncDirectory(context.root);
    return true;
  } catch {
    return false;
  }
}

function leaseFor(context: LeaseContext): HeldActivationLease {
  const { root, lockPath, ownerPath, file, native, record, lock, identity, signal } = context;
  let released = false;
  const assertHeld = async (): Promise<void> => {
    if (released || signal?.aborted) {
      throw new Error('activation ownership is not held');
    }
    await assertLock(file, lockPath, lock);
    const current = await readOwner(ownerPath);
    if (current.status !== 'valid' || !equalRecord(current.record, record)) {
      throw new Error('activation ownership is not held');
    }
    if ((await identityState(identity, current.record)).kind !== 'confirmed') {
      throw new Error('activation ownership is not held');
    }
  };
  const release = async (): Promise<void> => {
    if (released) {
      return;
    }
    released = true;
    let failure: unknown;
    try {
      if (await lockStillOwned(file, lockPath, lock)) {
        const current = await readOwner(ownerPath);
        if (current.status === 'valid' && equalRecord(current.record, record)) {
          await unlink(ownerPath);
          await syncDirectory(root);
        }
      }
    } catch (error) {
      failure = error;
    }
    try {
      await closeLock(file, native);
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) {
      throw new Error('activation ownership cleanup failed');
    }
  };
  return Object.freeze({ assertHeld, release });
}

type LockResult =
  | { readonly status: 'busy' }
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'ready';
      readonly file: FileHandle;
      readonly native: NativeLock;
      readonly lock: LockIdentity;
    };

async function openActivationLock(lockPath: string): Promise<LockResult> {
  const adapter = new PosixFlockAdapter();
  const base = adapter.openFlags(globalThis.process.platform);
  const fresh = base | constants.O_EXCL | constants.O_NONBLOCK;
  let file: FileHandle;
  try {
    file = await open(lockPath, fresh, 0o600);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      return { status: 'unavailable' };
    }
    try {
      file = await open(lockPath, (base & ~constants.O_CREAT) | constants.O_NONBLOCK);
    } catch {
      return { status: 'unavailable' };
    }
  }
  let native: NativeLock | undefined;
  try {
    native = await adapter.lock(file);
    if (native === undefined) {
      await file.close();
      return { status: 'busy' };
    }
    return { status: 'ready', file, native, lock: await safeLock(file, lockPath) };
  } catch {
    try {
      native?.unlock();
    } catch {
      // The descriptor is closed below; this is an unavailable acquisition.
    }
    await file.close().catch(() => undefined);
    return { status: 'unavailable' };
  }
}

async function previousOwnerState(
  prior: OwnerRead,
  channel: 'stable' | 'alpha',
  lock: LockIdentity,
  identity: ProcessIdentityService,
): Promise<'stale' | 'busy' | 'unavailable'> {
  if (prior.status === 'absent') {
    return 'stale';
  }
  if (prior.status === 'unavailable') {
    return 'unavailable';
  }
  if (
    prior.record.channel !== channel ||
    prior.record.process.platform !== globalThis.process.platform ||
    (uid() !== undefined && prior.record.process.uid !== uid()) ||
    prior.record.lock.dev !== lock.dev ||
    prior.record.lock.ino !== lock.ino
  ) {
    return 'unavailable';
  }
  const state = await identityState(identity, prior.record);
  if (state.kind === 'confirmed') {
    return 'busy';
  }
  return state.kind === 'missing' || state.kind === 'mismatch' ? 'stale' : 'unavailable';
}

type ClaimResult = { readonly result: ActivationOwnership; readonly transferred: boolean };

async function claimOwnership(context: ClaimContext): Promise<ClaimResult> {
  const { root, ownerPath, lock, channel, identity, signal } = context;
  const process = await identity.capture(globalThis.process.pid).catch(() => undefined);
  if (process === undefined) {
    return { result: unavailable('activation identity unavailable'), transferred: false };
  }
  if (signal?.aborted) {
    return { result: { status: 'cancelled' }, transferred: false };
  }
  const record = recordFor(channel, process, lock);
  const failClaim = async (cancelled: boolean): Promise<ClaimResult> => {
    const cleaned = await cleanupClaim(context, record);
    return {
      result:
        cancelled && cleaned
          ? { status: 'cancelled' }
          : unavailable('activation owner unavailable'),
      transferred: false,
    };
  };
  try {
    await writeOwner(root, record);
    if (signal?.aborted) {
      return failClaim(true);
    }
    const current = await readOwner(ownerPath);
    if (current.status !== 'valid' || !equalRecord(current.record, record)) {
      return failClaim(false);
    }
    const lease = leaseFor({ ...context, record });
    if (signal?.aborted) {
      await lease.release();
      return { result: { status: 'cancelled' }, transferred: true };
    }
    return { result: { status: 'held', lease }, transferred: true };
  } catch {
    return failClaim(false);
  }
}

export async function acquireActivationOwnership({
  channelRoot,
  channel,
  signal,
}: {
  readonly channelRoot: string;
  readonly channel: 'stable' | 'alpha';
  readonly signal?: AbortSignal;
}): Promise<ActivationOwnership> {
  if (signal?.aborted) {
    return { status: 'cancelled' };
  }
  if (!validRootInput(channelRoot, channel)) {
    return unavailable('activation channel unavailable');
  }
  const root = await privateDirectory(channelRoot);
  if (root === undefined) {
    return unavailable('activation channel unavailable');
  }
  const lockPath = join(root, LOCK_FILE);
  const ownerPath = join(root, OWNER_FILE);
  const opened = await openActivationLock(lockPath);
  if (opened.status === 'busy') {
    return { status: 'busy' };
  }
  if (opened.status === 'unavailable') {
    return unavailable('activation lock unavailable');
  }
  const { file, native, lock } = opened;
  const identity = new ProcessIdentityService();
  let transferred = false;
  try {
    const prior = await readOwner(ownerPath);
    const previous = await previousOwnerState(prior, channel, lock, identity);
    if (previous === 'unavailable') {
      return unavailable('activation owner unavailable');
    }
    if (previous === 'busy') {
      return { status: 'busy' };
    }
    const claim = await claimOwnership({
      root,
      lockPath,
      ownerPath,
      file,
      native,
      lock,
      channel,
      identity,
      ...(signal === undefined ? {} : { signal }),
    });
    transferred = claim.transferred;
    return claim.result;
  } catch {
    return unavailable('activation owner unavailable');
  } finally {
    if (!transferred) {
      await closeLock(file, native).catch(() => undefined);
    }
  }
}
