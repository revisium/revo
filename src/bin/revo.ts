#!/usr/bin/env node

// oxlint-disable-next-line import/no-unassigned-import -- decorators require this side effect first
import 'reflect-metadata';
import { CliBootstrapService } from '../cli/cli-bootstrap.service.js';
import { OutputService } from '../cli/output.service.js';
import { PackageMetadataService } from '../cli/package-metadata.service.js';

const output = new OutputService();
const bootstrap = new CliBootstrapService(new PackageMetadataService(), output);

try {
  process.exitCode = await bootstrap.run();
} catch (error: unknown) {
  output.writeError(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
