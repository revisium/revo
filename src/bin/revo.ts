#!/usr/bin/env node

// oxlint-disable-next-line import/no-unassigned-import -- decorators require this side effect first
import 'reflect-metadata';
import { CliBootstrapService } from '../cli/cli-bootstrap.service.js';
import { OutputService } from '../cli/output.service.js';
import { PackageMetadataService } from '../cli/package-metadata.service.js';
import { errorMessage } from '../errors.js';
import { ignoreOutputFailures } from '../server-logs/process-output.js';

// Output is best effort: a closed stdout or stderr never changes a command's outcome.
ignoreOutputFailures();

const output = new OutputService();
const bootstrap = new CliBootstrapService(new PackageMetadataService(), output);

try {
  process.exitCode = await bootstrap.run();
} catch (error: unknown) {
  output.writeError(errorMessage(error));
  process.exitCode = 1;
}
