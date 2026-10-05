import { Injectable } from '@nestjs/common';

import packageMetadata from '../../package.json' with { type: 'json' };
import { channelCommand, selectChannel } from '../channel.js';

/** The command this process was started as; an invalid channel setting is reported later. */
function commandName(version: string): string {
  try {
    return channelCommand(selectChannel({ env: process.env, flags: {}, packageVersion: version }));
  } catch {
    return Object.keys(packageMetadata.bin)[0] ?? packageMetadata.name;
  }
}

@Injectable()
export class PackageMetadataService {
  readonly cliName = commandName(packageMetadata.version);
  readonly version = packageMetadata.version;
}
