export type ReleaseChannel = 'stable' | 'alpha';
export type InstallPlatform = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';

export interface ToolchainRelease {
  readonly version: string;
  readonly url: string;
  readonly sha256: Readonly<Record<InstallPlatform, string>>;
}

export interface InstallScriptRelease {
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly releaseUrl: string;
  readonly sha256: {
    readonly package: string;
    readonly lockfile: string;
    readonly workspace: string;
  };
  readonly node: ToolchainRelease;
  readonly pnpm: ToolchainRelease;
}

export const INSTALL_PLATFORMS: readonly InstallPlatform[];

export function installScriptName(channel: ReleaseChannel): string;
export function releaseAssetNames(version: string): {
  readonly package: string;
  readonly lockfile: string;
  readonly workspace: string;
};
export function nodeArchiveName(version: string, platform: InstallPlatform): string;
export function pnpmArchiveName(platform: InstallPlatform): string;
export function renderInstallScript(release: InstallScriptRelease): string;
