#!/usr/bin/env node

import packageMetadata from '../../package.json' with { type: 'json' };
import { runFoundationCli } from '../foundation-cli.js';

process.exitCode = runFoundationCli(process.argv.slice(2), packageMetadata.version, console);
