import { Injectable } from '@nestjs/common';

import packageMetadata from '../../package.json' with { type: 'json' };

@Injectable()
export class PackageMetadataService {
  readonly cliName = Object.keys(packageMetadata.bin)[0] ?? packageMetadata.name;
  readonly version = packageMetadata.version;
}
