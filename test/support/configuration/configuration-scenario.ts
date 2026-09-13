import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  ConfigurationFile,
  ConfigurationFlags,
  RevoConfiguration,
} from '../../../src/configuration/configuration.types.js';
import { ConfigurationResolver } from '../../../src/configuration/index.js';
import type { ReleaseChannel } from '../../../src/layout.js';

export class ConfigurationScenario {
  private env: Record<string, string | undefined> = {};
  private file: unknown;
  private flags: ConfigurationFlags = {};
  private packageVersion = '1.0.0';
  private platform: 'darwin' | 'linux' = 'linux';
  private wrapperChannel: ReleaseChannel | undefined;
  private explicitMissing = false;
  private fileSelection: 'environment' | 'flags' = 'flags';

  private constructor() {}

  static defaults(): ConfigurationScenario {
    return new ConfigurationScenario();
  }

  withEnv(env: Record<string, string | undefined>): this {
    this.env = { ...env };
    return this;
  }

  withFile(file: unknown): this {
    this.file = file;
    return this;
  }

  withEnvironmentFile(file: unknown): this {
    this.file = file;
    this.fileSelection = 'environment';
    return this;
  }

  withFlags(flags: ConfigurationFlags): this {
    this.flags = { ...flags };
    return this;
  }

  withPackageVersion(version: string): this {
    this.packageVersion = version;
    return this;
  }

  withPlatform(platform: 'darwin' | 'linux'): this {
    this.platform = platform;
    return this;
  }

  withWrapper(channel: ReleaseChannel): this {
    this.wrapperChannel = channel;
    return this;
  }

  withMissingExplicitFile(): this {
    this.explicitMissing = true;
    return this;
  }

  async resolve(): Promise<Readonly<RevoConfiguration>> {
    return this.inFixture(async (homeDir, configPath) => {
      const env = { ...this.env };
      const flags = { ...this.flags };
      if (this.explicitMissing) {
        flags.config = path.join(homeDir, 'missing.json');
      }
      if (this.file !== undefined) {
        await mkdir(path.dirname(configPath), { recursive: true });
        await writeFile(
          configPath,
          typeof this.file === 'string' ? this.file : JSON.stringify(this.file),
        );
        if (this.fileSelection === 'environment') {
          env.REVO_CONFIG = configPath;
        } else {
          flags.config = configPath;
        }
      }
      return new ConfigurationResolver().resolve({
        env,
        flags,
        homeDir,
        packageVersion: this.packageVersion,
        platform: this.platform,
        ...(this.wrapperChannel === undefined ? {} : { wrapperChannel: this.wrapperChannel }),
      });
    });
  }

  async preservesInputs(): Promise<boolean> {
    const env = Object.freeze({ ...this.env });
    const flags = Object.freeze({ ...this.flags });
    return this.inFixture(async (homeDir) => {
      await new ConfigurationResolver().resolve({
        env,
        flags,
        homeDir,
        packageVersion: this.packageVersion,
        platform: this.platform,
      });
      return Object.isFrozen(env) && Object.isFrozen(flags);
    });
  }

  private async inFixture<T>(
    action: (homeDir: string, configPath: string) => Promise<T>,
  ): Promise<T> {
    const root = await mkdtemp(path.join(tmpdir(), 'revo config '));
    const homeDir = path.join(root, 'home with spaces');
    const configPath = path.join(root, 'selected config.json');
    await mkdir(homeDir, { recursive: true });
    try {
      return await action(homeDir, configPath);
    } finally {
      await rm(root, { recursive: true });
    }
  }
}

export function configFile(overrides: Partial<ConfigurationFile> = {}): ConfigurationFile {
  return { schemaVersion: 1, ...overrides };
}
