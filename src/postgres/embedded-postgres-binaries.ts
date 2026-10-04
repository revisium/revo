import { isAbsolute } from 'node:path';

import { EmbeddedPostgresError, type EmbeddedPostgresBinaries } from './embedded-postgres.types.js';

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
    return Object.freeze({
      initdb: candidate.initdb,
      pgCtl: candidate.pg_ctl,
      postgres: candidate.postgres,
    });
  } catch (error) {
    if (error instanceof EmbeddedPostgresError) {
      throw error;
    }
    throw new EmbeddedPostgresError('unsupported');
  }
}

const isBinaries = (
  value: unknown,
): value is { readonly initdb: string; readonly pg_ctl: string; readonly postgres: string } =>
  typeof value === 'object' &&
  value !== null &&
  'initdb' in value &&
  absolutePath(value.initdb) &&
  'pg_ctl' in value &&
  absolutePath(value.pg_ctl) &&
  'postgres' in value &&
  absolutePath(value.postgres);

const absolutePath = (value: unknown): value is string =>
  typeof value === 'string' && isAbsolute(value);
