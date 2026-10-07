import type { ServerLaunchResult } from '../server/server-launcher.service.js';

/**
 * A running server keeps its own version until it is restarted. Returns the line that says how to
 * move it to the installed version, or undefined when the server is not running or is current.
 */
export function staleServerNotice(
  outcome: ServerLaunchResult,
  installed: string,
  command: string,
): string | undefined {
  if (outcome.kind !== 'running') {
    return undefined;
  }
  const running = outcome.status.version;
  if (running === undefined || running === installed) {
    return undefined;
  }
  return `Revo ${running} is running; restart it to use ${installed}: \`${command} server stop\`, then \`${command}\`.`;
}
