import { join } from 'node:path';

import type { ActivationRecord } from './activation-record.js';

const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function activationLauncher(channelRoot: string, record: ActivationRecord): string {
  const node = join(channelRoot, record.toolchain.nodeRef, 'bin', 'node');
  const bin = join(channelRoot, record.packageRef, record.packageBin);
  return `#!/bin/sh\nexec ${quote(node)} ${quote(bin)} "$@"\n`;
}
