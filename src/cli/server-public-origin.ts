import type { ServerLaunchResult } from '../server/server-launcher.service.js';

const URL_UNAVAILABLE = 'Server is running, but its public URL is unavailable.';
const INVALID_URL = 'Server public URL is invalid.';

type NotStarted = Exclude<ServerLaunchResult, { readonly kind: 'started' | 'running' }>;

export function serverPublicOrigin(outcome: ServerLaunchResult): string {
  if (outcome.kind === 'started') {
    return validOrigin(outcome.url);
  }
  if (outcome.kind === 'running') {
    if (outcome.status.publicUrl === undefined) {
      throw new Error(URL_UNAVAILABLE);
    }
    return validOrigin(outcome.status.publicUrl);
  }
  throw startNotPerformed(outcome);
}

/** Explains a launch outcome that leaves no server running for this command. */
export function startNotPerformed(outcome: NotStarted): Error {
  if (outcome.kind === 'stopped') {
    return new Error('Server did not start.');
  }
  if (outcome.kind === 'owned') {
    return new Error(
      'Another Revo server still owns the data directory but does not answer; start was not performed.',
    );
  }
  if (outcome.kind === 'unknown' || outcome.kind === 'missing') {
    return new Error('Server status is unavailable; start was not performed.');
  }
  return new Error(`Server is ${outcome.kind}; start was not performed.`);
}

function validOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      (url.pathname !== '' && url.pathname !== '/')
    ) {
      throw new Error('invalid origin');
    }
    return url.origin;
  } catch {
    throw new Error(INVALID_URL);
  }
}
