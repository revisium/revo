const POSIX_CORE_ENVIRONMENT_NAMES = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
] as const;

const forbiddenName = (name: string) =>
  name.startsWith('PG') ||
  name === 'DATABASE_URL' ||
  name === 'REVO_RUN_DATABASE_URL' ||
  name === 'CHECKPOINT_DISABLE' ||
  name === 'NODE_TLS_REJECT_UNAUTHORIZED';

export interface CoreChildEnvironment {
  readonly env: Readonly<Record<string, string>>;
  readonly inheritedEnvironmentNames: readonly string[];
}

/** Copies only named inputs into the Core child and its agent-runtime allowlist. */
export const buildCoreChildEnvironment = (
  source: NodeJS.ProcessEnv,
  trustedEnvironmentNames: readonly string[] = [],
): CoreChildEnvironment => {
  const names = [...new Set([...POSIX_CORE_ENVIRONMENT_NAMES, ...trustedEnvironmentNames])].filter(
    (name) => !forbiddenName(name) && source[name] !== undefined,
  );
  const entries = names.flatMap((name) => {
    const value = source[name];
    return typeof value === 'string' ? [[name, value] as const] : [];
  });
  const env = Object.fromEntries(entries);
  return {
    env: { ...env, CHECKPOINT_DISABLE: '1', PGPASSWORD: '', PGPASSFILE: '/dev/null' },
    inheritedEnvironmentNames: names,
  };
};
