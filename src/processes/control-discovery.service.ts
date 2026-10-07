import { Injectable } from '@nestjs/common';

import { readPrivateDataFile } from '../private-files.js';
import type { ControlDiscovery } from './control-discovery.types.js';
import { parseControlRecord } from './control-protocol.js';

export const CONTROL_FILE = '.revo-control.json';
export const MAX_CONTROL_METADATA_BYTES = 16_384;

@Injectable()
export class ControlDiscoveryService {
  async read(dataDir: string): Promise<ControlDiscovery> {
    const file = await readPrivateDataFile(dataDir, CONTROL_FILE, MAX_CONTROL_METADATA_BYTES);
    if (file.kind !== 'read') {
      return { kind: file.kind };
    }
    try {
      const record = parseControlRecord(JSON.parse(file.content));
      return record?.canonicalDataDir === file.canonicalDataDir
        ? { kind: 'found', record }
        : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  }
}
