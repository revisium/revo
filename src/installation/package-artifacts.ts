// oxlint-disable curly, no-await-in-loop, no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion -- bounded streaming and typed artifact maps

import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { PackageInstallPlan } from './package-install-plan.js';

export const DEFAULT_PACKAGE_ARTIFACT_POLICY = Object.freeze({
  downloadTimeoutMs: 60_000,
  terminationGraceMs: 5_000,
  maxDownloadBytes: 512 * 1024 * 1024,
  redirectLimit: 2,
});
export const PACKAGE_ARTIFACT_NAMES = [
  'package',
  'packageJson',
  'pnpmLock',
  'pnpmWorkspace',
] as const;
export type PackageArtifactName = (typeof PACKAGE_ARTIFACT_NAMES)[number];
export type PackageArtifactBytes = { readonly [Name in PackageArtifactName]: Uint8Array };
export type PackageArtifactRequest = (
  url: string,
  init: { readonly redirect: 'manual'; readonly signal: AbortSignal },
) => Promise<unknown>;
export interface PackageArtifactPolicy {
  readonly downloadTimeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly maxDownloadBytes?: number;
  readonly redirectLimit?: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (stage: string, reason: string): Error => new Error(`package ${stage}: ${reason}`);
const header = (response: Record<string, unknown>, name: string): string | undefined => {
  const headers = response.headers;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (record(headers) && typeof headers[name] === 'string') return headers[name] as string;
  return undefined;
};
const dispose = async (response: Record<string, unknown>): Promise<void> => {
  const body = response.body;
  await (record(body) && typeof body.cancel === 'function' ? body.cancel() : undefined);
};
const policyFor = (value: PackageArtifactPolicy = {}) => {
  const policy = { ...DEFAULT_PACKAGE_ARTIFACT_POLICY, ...value };
  if (
    ![policy.downloadTimeoutMs, policy.terminationGraceMs, policy.maxDownloadBytes].every(
      (item) => Number.isSafeInteger(item) && item > 0,
    ) ||
    policy.maxDownloadBytes > DEFAULT_PACKAGE_ARTIFACT_POLICY.maxDownloadBytes ||
    !Number.isSafeInteger(policy.redirectLimit) ||
    policy.redirectLimit < 0 ||
    policy.redirectLimit > 5
  )
    throw fail('validate', 'policy is unbounded');
  return policy;
};
const validUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail('validate', 'artifact URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw fail('validate', 'artifact URL is not canonical');
  return url;
};
const redirectUrl = (value: string, initial: URL): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail('download', 'redirect URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.search && url.hostname !== 'release-assets.githubusercontent.com')
  )
    throw fail('download', 'redirect URL is not canonical');
  if (url.hostname !== initial.hostname && url.hostname !== 'release-assets.githubusercontent.com')
    throw fail('download', 'redirect origin is not allowed');
  return url;
};
async function fetchBytes /* NOSONAR -- bounded redirect and streaming state machine */(
  url: string,
  policy: ReturnType<typeof policyFor>,
  signal: AbortSignal | undefined,
  request: PackageArtifactRequest | undefined,
): Promise<Uint8Array> {
  const initial = validUrl(url);
  const fetcher = request ?? (globalThis.fetch as PackageArtifactRequest | undefined);
  if (fetcher === undefined) throw fail('download', 'request is unavailable');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), policy.downloadTimeoutMs);
  let current = initial.href;
  let redirects = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw fail('download', 'cancelled');
      const responseValue = await fetcher(current, {
        redirect: 'manual',
        signal: controller.signal,
      });
      if (!record(responseValue) || typeof responseValue.status !== 'number')
        throw fail('download', 'request returned no response');
      if (![301, 302, 303, 307, 308].includes(responseValue.status)) {
        if (responseValue.status !== 200) {
          await dispose(responseValue);
          throw fail('download', `HTTP ${responseValue.status}`);
        }
        const rawLength = header(responseValue, 'content-length');
        const length = rawLength === undefined || rawLength === '' ? undefined : Number(rawLength);
        if (
          length !== undefined &&
          (!Number.isSafeInteger(length) || length > policy.maxDownloadBytes)
        ) {
          await dispose(responseValue);
          throw fail('download', 'artifact exceeds size bound');
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          const body = responseValue.body;
          if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
            for await (const chunk of body as AsyncIterable<Uint8Array>) {
              const bytes = new Uint8Array(chunk);
              size += bytes.length;
              if (size > policy.maxDownloadBytes)
                throw fail('download', 'artifact exceeds size bound');
              chunks.push(bytes);
            }
          } else if (typeof responseValue.arrayBuffer === 'function') {
            const bytes = new Uint8Array(await responseValue.arrayBuffer());
            size = bytes.length;
            if (size > policy.maxDownloadBytes)
              throw fail('download', 'artifact exceeds size bound');
            chunks.push(bytes);
          } else throw fail('download', 'response body is missing');
        } catch (error) {
          await dispose(responseValue);
          throw error;
        }
        if (length !== undefined && size !== length)
          throw fail('download', 'response was truncated');
        const result = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        if (signal?.aborted) throw fail('download', 'cancelled');
        return result;
      }
      const location = header(responseValue, 'location');
      if (location === undefined || redirects++ >= policy.redirectLimit) {
        await dispose(responseValue);
        throw fail('download', 'redirect is invalid or exceeded');
      }
      let next: URL;
      try {
        next = redirectUrl(new URL(location, current).href, initial);
      } catch (error) {
        await dispose(responseValue);
        throw error;
      }
      await dispose(responseValue);
      current = next.href;
    }
  } catch (error) {
    if (signal?.aborted) throw fail('download', 'cancelled');
    if (controller.signal.aborted) throw fail('download', 'timed out');
    if (error instanceof Error && error.message.startsWith('package ')) throw error;
    throw fail('download', 'request failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function acquirePackageArtifacts({
  plan,
  scratch,
  policy: inputPolicy,
  signal,
  request,
  onProgress,
}: {
  readonly plan: PackageInstallPlan;
  readonly scratch: string;
  readonly policy?: PackageArtifactPolicy;
  readonly signal?: AbortSignal;
  readonly request?: PackageArtifactRequest;
  readonly onProgress?: (stage: string, artifact?: PackageArtifactName) => void;
}): Promise<{
  readonly directory: string;
  readonly files: { readonly [Name in PackageArtifactName]: string };
  readonly bytes: PackageArtifactBytes;
}> {
  if (typeof scratch !== 'string' || !isAbsolute(scratch))
    throw fail('validate', 'scratch must be absolute');
  const info = await lstat(scratch).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink())
    throw fail('validate', 'scratch must be an owned directory');
  if (signal?.aborted) throw fail('validate', 'cancelled');
  const policy = policyFor(inputPolicy);
  const directory = await mkdtemp(join(scratch, '.package-artifacts-'));
  const files = Object.fromEntries(
    PACKAGE_ARTIFACT_NAMES.map((name) => [name, join(directory, `${name}.artifact`)]),
  ) as { [Name in PackageArtifactName]: string };
  const bytes = {} as { [Name in PackageArtifactName]: Uint8Array };
  let transferred = false;
  try {
    for (const name of PACKAGE_ARTIFACT_NAMES) {
      onProgress?.('download', name);
      const value = await fetchBytes(plan.artifacts[name].url, policy, signal, request);
      onProgress?.('verify', name);
      const sha256 = createHash('sha256').update(value).digest('hex');
      if (sha256 !== plan.artifacts[name].sha256) throw fail('verify', `${name} SHA-256 mismatch`);
      if ('integrity' in plan.artifacts[name]) {
        const integrity = `sha512-${createHash('sha512').update(value).digest('base64')}`;
        if (integrity !== plan.artifacts[name].integrity)
          throw fail('verify', `${name} SRI mismatch`);
      }
      bytes[name] = value;
      await writeFile(files[name], value, { mode: 0o600, flag: 'wx' });
    }
    transferred = true;
    return { directory, files, bytes };
  } finally {
    if (!transferred) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
