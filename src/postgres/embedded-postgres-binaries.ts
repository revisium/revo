import { isAbsolute } from 'node:path';

import type { EmbeddedPostgresBinaries } from './embedded-postgres.types.js';
import { EmbeddedPostgresError } from './embedded-postgres.types.js';

const packages = {
  'darwin-arm64': '@embedded-postgres/darwin-arm64',
  'darwin-x64': '@embedded-postgres/darwin-x64',
  'linux-arm64': '@embedded-postgres/linux-arm64',
  'linux-x64': '@embedded-postgres/linux-x64',
} as const;

export async function loadEmbeddedPostgresBinaries(): Promise<EmbeddedPostgresBinaries> {
  const platform = `${process.platform}-${process.arch}`;
  const packageName = Object.entries(packages).find(([candidate]) => candidate === platform)?.[1];
  if (!packageName) {
    throw new EmbeddedPostgresError('unsupported');
  }
  try {
    const candidate: unknown = await import(packageName);
    if (!isBinaries(candidate)) {
      throw new EmbeddedPostgresError('invalid');
    }
    return Object.freeze({ initdb: candidate.initdb, postgres: candidate.postgres });
  } catch (error) {
    if (error instanceof EmbeddedPostgresError) {
      throw error;
    }
    throw new EmbeddedPostgresError('unsupported');
  }
}

const isBinaries = (value: unknown): value is EmbeddedPostgresBinaries =>
  typeof value === 'object' &&
  value !== null &&
  'initdb' in value &&
  typeof value.initdb === 'string' &&
  isAbsolute(value.initdb) &&
  'postgres' in value &&
  typeof value.postgres === 'string' &&
  isAbsolute(value.postgres);
