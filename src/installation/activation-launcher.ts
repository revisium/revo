import { join } from 'node:path';

import type { ActivationRecord } from './activation-record.js';

const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function activationLauncher(channelRoot: string, record: ActivationRecord): string {
  const node = join(channelRoot, record.toolchain.nodeRef, 'bin', 'node');
  const bin = join(channelRoot, record.packageRef, record.packageBin);
  return `#!/bin/sh\nexport REVO_ACTIVATION_CHANNEL_ROOT=${quote(channelRoot)}\nexport REVO_ACTIVATION_GENERATION_ID=${quote(record.generationId)}\nexec ${quote(node)} ${quote(bin)} "$@"\n`;
}
