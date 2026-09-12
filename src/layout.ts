import path from 'node:path';

export type ReleaseChannel = 'stable' | 'alpha';
export type SupportedPlatform = 'darwin' | 'linux' | 'win32';

export interface LayoutInput {
  channel: ReleaseChannel;
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  platform: SupportedPlatform;
}

export interface RevoLayout {
  cacheDir: string;
  channel: ReleaseChannel;
  configDir: string;
  dataDir: string;
  runtimeDir: string;
  stateDir: string;
}

type PathApi = Pick<typeof path.posix, 'isAbsolute' | 'join' | 'normalize'>;

function requireAbsolute(directory: string, pathApi: PathApi, label: string): string {
  if (!pathApi.isAbsolute(directory)) {
    throw new Error(`${label} must be an absolute path`);
  }

  return pathApi.normalize(directory);
}

function optionalEnvironmentPath(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

function requireChannel(channel: unknown): asserts channel is ReleaseChannel {
  if (channel !== 'stable' && channel !== 'alpha') {
    throw new Error('channel must be stable or alpha');
  }
}

function resolveWindowsLayout(input: LayoutInput): RevoLayout {
  const pathApi = path.win32;
  const homeDir = requireAbsolute(input.homeDir, pathApi, 'homeDir');
  const roamingRoot = requireAbsolute(
    optionalEnvironmentPath(input.env.APPDATA) ?? pathApi.join(homeDir, 'AppData', 'Roaming'),
    pathApi,
    'APPDATA',
  );
  const localRoot = requireAbsolute(
    optionalEnvironmentPath(input.env.LOCALAPPDATA) ?? pathApi.join(homeDir, 'AppData', 'Local'),
    pathApi,
    'LOCALAPPDATA',
  );
  const productName = input.channel === 'stable' ? 'Revo' : 'Revo Alpha';
  const productRoot = pathApi.join('Revisium', productName);
  const stateDir = pathApi.join(localRoot, productRoot, 'state');

  return {
    channel: input.channel,
    configDir: pathApi.join(roamingRoot, productRoot, 'config'),
    dataDir: pathApi.join(localRoot, productRoot, 'data'),
    stateDir,
    cacheDir: pathApi.join(localRoot, productRoot, 'cache'),
    runtimeDir: pathApi.join(stateDir, 'run'),
  };
}

function resolveMacOsLayout(input: LayoutInput): RevoLayout {
  const pathApi = path.posix;
  const homeDir = requireAbsolute(input.homeDir, pathApi, 'homeDir');
  const productName = input.channel === 'stable' ? 'Revo' : 'Revo Alpha';
  const productRoot = pathApi.join(homeDir, 'Library', 'Application Support', productName);
  const stateDir = pathApi.join(productRoot, 'state');

  return {
    channel: input.channel,
    configDir: pathApi.join(productRoot, 'config'),
    dataDir: pathApi.join(productRoot, 'data'),
    stateDir,
    cacheDir: pathApi.join(homeDir, 'Library', 'Caches', productName),
    runtimeDir: pathApi.join(stateDir, 'run'),
  };
}

function resolveLinuxLayout(input: LayoutInput): RevoLayout {
  const pathApi = path.posix;
  const homeDir = requireAbsolute(input.homeDir, pathApi, 'homeDir');
  const productName = input.channel === 'stable' ? 'revo' : 'revo-alpha';
  const configRoot = requireAbsolute(
    optionalEnvironmentPath(input.env.XDG_CONFIG_HOME) ?? pathApi.join(homeDir, '.config'),
    pathApi,
    'XDG_CONFIG_HOME',
  );
  const dataRoot = requireAbsolute(
    optionalEnvironmentPath(input.env.XDG_DATA_HOME) ?? pathApi.join(homeDir, '.local', 'share'),
    pathApi,
    'XDG_DATA_HOME',
  );
  const stateRoot = requireAbsolute(
    optionalEnvironmentPath(input.env.XDG_STATE_HOME) ?? pathApi.join(homeDir, '.local', 'state'),
    pathApi,
    'XDG_STATE_HOME',
  );
  const cacheRoot = requireAbsolute(
    optionalEnvironmentPath(input.env.XDG_CACHE_HOME) ?? pathApi.join(homeDir, '.cache'),
    pathApi,
    'XDG_CACHE_HOME',
  );
  const stateDir = pathApi.join(stateRoot, productName);
  const runtimeRoot = input.env.XDG_RUNTIME_DIR
    ? requireAbsolute(input.env.XDG_RUNTIME_DIR, pathApi, 'XDG_RUNTIME_DIR')
    : pathApi.join(stateDir, 'run');

  return {
    channel: input.channel,
    configDir: pathApi.join(configRoot, productName),
    dataDir: pathApi.join(dataRoot, productName),
    stateDir,
    cacheDir: pathApi.join(cacheRoot, productName),
    runtimeDir: input.env.XDG_RUNTIME_DIR ? pathApi.join(runtimeRoot, productName) : runtimeRoot,
  };
}

export function resolveRevoLayout(input: LayoutInput): RevoLayout {
  requireChannel(input.channel);

  const resolvers: Record<SupportedPlatform, (layoutInput: LayoutInput) => RevoLayout> = {
    darwin: resolveMacOsLayout,
    linux: resolveLinuxLayout,
    win32: resolveWindowsLayout,
  };

  return resolvers[input.platform](input);
}
