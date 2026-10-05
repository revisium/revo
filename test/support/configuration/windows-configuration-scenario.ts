import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  ConfigurationFlags,
  RevoConfiguration,
} from '../../../src/configuration/configuration.types.js';
import { ConfigFileLoader, ConfigurationResolver } from '../../../src/configuration/index.js';
import type { ReleaseChannel } from '../../../src/layout.js';

const DEFAULT_HOME = 'C:\\Users\\Revo User';
const DEFAULT_APPDATA = `${DEFAULT_HOME}\\AppData\\Roaming`;
const DEFAULT_LOCALAPPDATA = `${DEFAULT_HOME}\\AppData\\Local`;

export interface WindowsConfigurationScenarioOptions {
  readonly expectedConfigPath: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly flags?: Readonly<ConfigurationFlags>;
  readonly homeDir?: string;
  readonly file?: unknown;
  readonly fileText?: string;
  readonly packageVersion?: string;
  readonly wrapperChannel?: ReleaseChannel;
}

export interface WindowsConfigurationFileRead {
  readonly logicalPath: string;
  readonly explicit: boolean;
}

class WindowsPathBackingConfigFileLoader extends ConfigFileLoader {
  constructor(
    private readonly expectedLogicalPath: string,
    private readonly physicalPath: string,
    private readonly reads: WindowsConfigurationFileRead[],
  ) {
    super();
  }

  override async read(logicalPath: string, explicit: boolean): Promise<unknown> {
    this.reads.push({ logicalPath, explicit });
    if (logicalPath !== this.expectedLogicalPath) {
      throw new Error('WINDOWS_CONFIGURATION_FIXTURE_PATH_MISMATCH');
    }
    return super.read(this.physicalPath, explicit);
  }
}

/** Backs injected Windows paths with a real temporary file on the current host. */
export class WindowsConfigurationScenario {
  readonly reads: WindowsConfigurationFileRead[] = [];

  constructor(private readonly options: WindowsConfigurationScenarioOptions) {}

  async resolve(): Promise<Readonly<RevoConfiguration>> {
    const root = await mkdtemp(path.join(tmpdir(), 'revo windows config '));
    try {
      const physicalConfigPath = path.join(root, 'selected config.json');
      const hasFile = this.options.fileText !== undefined || this.options.file !== undefined;
      if (hasFile) {
        const content =
          this.options.fileText ??
          (typeof this.options.file === 'string'
            ? this.options.file
            : JSON.stringify(this.options.file));
        await writeFile(physicalConfigPath, content);
      }

      const loader = new WindowsPathBackingConfigFileLoader(
        this.options.expectedConfigPath,
        physicalConfigPath,
        this.reads,
      );
      const resolver = new ConfigurationResolver(loader);
      const env = Object.freeze({
        APPDATA: DEFAULT_APPDATA,
        LOCALAPPDATA: DEFAULT_LOCALAPPDATA,
        ...this.options.env,
      });
      const flags = Object.freeze({ ...this.options.flags });
      return await resolver.resolve({
        env,
        flags,
        homeDir: this.options.homeDir ?? DEFAULT_HOME,
        packageVersion: this.options.packageVersion ?? '1.0.0',
        platform: 'win32',
        ...(this.options.wrapperChannel === undefined
          ? {}
          : { wrapperChannel: this.options.wrapperChannel }),
      });
    } finally {
      await rm(root, { recursive: true });
    }
  }
}
