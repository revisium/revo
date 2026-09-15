import type { ReleaseChannel, RevoLayout } from '../layout.js';

/** Largest startup budget a launch deadline and the server host protocol can represent. */
export const MAX_STARTUP_TIMEOUT_MILLISECONDS = 2_147_483_647;

export interface ConfigurationFlags {
  readonly channel?: string;
  readonly config?: string;
  readonly databaseUrl?: string;
  readonly dataDir?: string;
  readonly host?: string;
  readonly logDir?: string;
  readonly port?: number | string;
  readonly publicUrl?: string;
  readonly startupTimeout?: number | string;
}

export interface ConfigurationInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly flags: Readonly<ConfigurationFlags>;
  readonly homeDir: string;
  readonly packageVersion: string;
  readonly platform: 'darwin' | 'linux';
  readonly wrapperChannel?: ReleaseChannel;
}

export interface RevoConfiguration {
  readonly channel: ReleaseChannel;
  readonly configPath: string;
  readonly databaseUrl?: string;
  readonly host: string;
  readonly installDir: string;
  readonly layout: Readonly<RevoLayout>;
  readonly logDir: string;
  readonly port: number;
  readonly publicUrl: string;
  readonly startupTimeout: number;
}

export interface ConfigurationFile {
  readonly databaseUrl?: string;
  readonly dataDir?: string;
  readonly host?: string;
  readonly logDir?: string;
  readonly port?: number;
  readonly publicUrl?: string;
  readonly schemaVersion: 1;
  readonly startupTimeout?: number;
}
