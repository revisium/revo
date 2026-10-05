import { invalidConfiguration } from './configuration/configuration-error.js';
import type { ReleaseChannel } from './layout.js';

/** Set by the installer's launcher so one command can never run another channel. */
export const LAUNCHER_CHANNEL_VARIABLE = 'REVO_LAUNCHER_CHANNEL';

export interface ChannelSelection {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly flags: { readonly channel?: string };
  readonly packageVersion: string;
}

/** The one place that names the command a user runs for a channel. */
export function channelCommand(channel: ReleaseChannel): string {
  return channel === 'stable' ? 'revo' : 'revo-alpha';
}

export function selectChannel(input: Readonly<ChannelSelection>): ReleaseChannel {
  const launcher = launcherChannel(input.env);
  const requests = [
    ['flags', input.flags.channel],
    ['environment', input.env.REVO_CHANNEL],
  ] as const;
  for (const [source, requested] of requests) {
    if (requested === undefined) {
      continue;
    }
    if (!isChannel(requested)) {
      invalidConfiguration('channel', source, 'must be stable or alpha');
    }
    if (launcher !== undefined && requested !== launcher) {
      invalidConfiguration(
        'channel',
        source,
        `${channelCommand(launcher)} runs the ${launcher} channel; use ${channelCommand(requested)} for ${requested}`,
      );
    }
  }
  const selected = input.flags.channel ?? input.env.REVO_CHANNEL;
  return launcher ?? (isChannel(selected) ? selected : channelOfVersion(input.packageVersion));
}

function launcherChannel(env: ChannelSelection['env']): ReleaseChannel | undefined {
  const declared = env[LAUNCHER_CHANNEL_VARIABLE];
  if (declared === undefined) {
    return undefined;
  }
  if (!isChannel(declared)) {
    invalidConfiguration(LAUNCHER_CHANNEL_VARIABLE, 'environment', 'must be stable or alpha');
  }
  return declared;
}

const isChannel = (value: string | undefined): value is ReleaseChannel =>
  value === 'stable' || value === 'alpha';

export function channelOfVersion(version: string): ReleaseChannel {
  return /^\d+\.\d+\.\d+-/u.test(version) ? 'alpha' : 'stable';
}
