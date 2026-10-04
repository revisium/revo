import { createHash } from 'node:crypto';
import { lstat, mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { RevoConsoleLogger } from '../server-logs/revo-console-logger.js';
import { ControlTransportError, controlEndpointByteLimit } from './control-protocol.js';

export const CONTROL_SOCKET_ROOT = Symbol('CONTROL_SOCKET_ROOT');
export const DEFAULT_CONTROL_SOCKET_ROOT = '/tmp';

export interface ControlEndpointScope {
  readonly runtimeDir: string;
  readonly instanceId: string;
  readonly channel: string;
  readonly canonicalDataDir: string;
}

type DirectoryOutcome =
  | { readonly kind: 'ready'; readonly endpoint: string }
  | { readonly kind: 'refused'; readonly reason: string };

class UnusableDirectoryError extends Error {
  constructor(directory: string, reason: string) {
    super(`${directory}: ${reason}`);
    this.name = 'UnusableDirectoryError';
  }
}

const logger = new RevoConsoleLogger('ControlEndpoint');

export async function prepareControlEndpoint(
  socketRoot: string,
  scope: ControlEndpointScope,
): Promise<string> {
  const short = await prepareShortDirectory(socketRoot, scope);
  if (short.kind === 'ready') {
    return short.endpoint;
  }
  const runtime = await prepareRuntimeDirectory(scope);
  if (runtime.kind === 'ready') {
    logger.warn(
      `Control socket directory is unusable (${short.reason}); using ${scope.runtimeDir} instead.`,
    );
    return runtime.endpoint;
  }
  throw new ControlTransportError(
    `No private control socket directory is usable: ${short.reason}; ${runtime.reason}`,
  );
}

async function prepareShortDirectory(
  socketRoot: string,
  scope: ControlEndpointScope,
): Promise<DirectoryOutcome> {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return refused(socketRoot, 'unavailable without a POSIX user');
  }
  const userDirectory = userDirectoryOf(socketRoot, uid);
  const directory = join(userDirectory, scopeName(scope));
  const endpoint = socketPath(directory, scope.instanceId);
  if (!fits(endpoint)) {
    return refused(directory, overlong());
  }
  try {
    await requireTrustedRoot(socketRoot);
    await createPrivateDirectory(userDirectory, false);
    await createPrivateDirectory(directory, false);
  } catch (error) {
    return unusable(directory, error);
  }
  return { kind: 'ready', endpoint };
}

export async function isPrivateEndpoint(socketRoot: string, endpoint: string): Promise<boolean> {
  const directories = await Promise.all(
    socketDirectoriesOf(socketRoot, endpoint).map((directory) => isPrivateDirectory(directory)),
  );
  if (directories.includes(false)) {
    return false;
  }
  const socket = await lstat(endpoint).catch(() => undefined);
  return socket?.isSocket() === true && socket.uid === process.getuid?.();
}

function socketDirectoriesOf(socketRoot: string, endpoint: string): readonly string[] {
  const directory = dirname(endpoint);
  const uid = process.getuid?.();
  if (uid !== undefined && dirname(directory) === userDirectoryOf(socketRoot, uid)) {
    return [dirname(directory), directory];
  }
  return [directory];
}

async function prepareRuntimeDirectory(scope: ControlEndpointScope): Promise<DirectoryOutcome> {
  const endpoint = socketPath(scope.runtimeDir, scope.instanceId);
  if (!fits(endpoint)) {
    return refused(scope.runtimeDir, overlong());
  }
  try {
    await createPrivateDirectory(scope.runtimeDir, true);
  } catch (error) {
    return unusable(scope.runtimeDir, error);
  }
  return { kind: 'ready', endpoint };
}

function scopeName(scope: ControlEndpointScope): string {
  return createHash('sha256')
    .update(JSON.stringify([scope.channel, scope.canonicalDataDir]), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

async function requireTrustedRoot(socketRoot: string): Promise<void> {
  if (!isAbsolute(socketRoot)) {
    throw new UnusableDirectoryError(socketRoot, 'not an absolute directory');
  }
  const root = await stat(socketRoot).catch(() => undefined);
  if (!root?.isDirectory()) {
    throw new UnusableDirectoryError(socketRoot, 'not a directory');
  }
  const sharedWithoutSticky = (root.mode & 0o002) !== 0 && (root.mode & 0o1000) === 0;
  if (sharedWithoutSticky) {
    throw new UnusableDirectoryError(socketRoot, 'writable by others without the sticky bit');
  }
}

async function createPrivateDirectory(directory: string, recursive: boolean): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700, recursive });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      throw new UnusableDirectoryError(directory, 'cannot be created');
    }
  }
  if (!(await isPrivateDirectory(directory))) {
    throw new UnusableDirectoryError(directory, 'not a private directory owned by this user');
  }
}

async function isPrivateDirectory(directory: string): Promise<boolean> {
  const state = await lstat(directory).catch(() => undefined);
  return (
    state?.isDirectory() === true && state.uid === process.getuid?.() && (state.mode & 0o077) === 0
  );
}

function refused(directory: string, reason: string): DirectoryOutcome {
  return { kind: 'refused', reason: `${directory}: ${reason}` };
}

function unusable(directory: string, error: unknown): DirectoryOutcome {
  return error instanceof UnusableDirectoryError
    ? { kind: 'refused', reason: error.message }
    : refused(directory, 'unavailable');
}

const userDirectoryOf = (socketRoot: string, uid: number) =>
  join(socketRoot, `revo-${String(uid)}`);

const socketPath = (directory: string, instanceId: string) =>
  join(directory, `c-${instanceId}.sock`);

const fits = (endpoint: string) => Buffer.byteLength(endpoint) <= controlEndpointByteLimit();

const overlong = () => `socket path exceeds ${String(controlEndpointByteLimit())} bytes`;

const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
