import { isAbsolute, relative, resolve, sep } from 'node:path';

export function isExactActivationHelperInvocation(command, args, options, env) {
  if (
    typeof command !== 'string' ||
    !Array.isArray(args) ||
    args.length !== 2 ||
    typeof args[0] !== 'string' ||
    typeof args[1] !== 'string' ||
    typeof options?.cwd !== 'string' ||
    typeof env?.REVO_PRIVATE_NODE_ROOT !== 'string' ||
    typeof env.REVO_INSTALL_ROOT !== 'string'
  ) {
    return false;
  }

  const executable = resolve(env.REVO_PRIVATE_NODE_ROOT, 'bin/node');
  const workingDirectory = resolve(options.cwd);
  const installRoot = resolve(env.REVO_INSTALL_ROOT);
  const requestPath = resolve(args[1]);
  const requestRelativePath = relative(installRoot, requestPath);
  return (
    isAbsolute(command) &&
    resolve(command) === executable &&
    resolve(args[0]) === resolve(workingDirectory, 'dist/bin/revo-install-activate.js') &&
    !isAbsolute(requestRelativePath) &&
    !requestRelativePath.startsWith(`..${sep}`) &&
    /^\.attempt\.[A-Za-z0-9_-]+\/runtime\/scratch\/\.activation-request-[A-Za-z0-9_-]+\/request\.json$/u.test(
      requestRelativePath,
    )
  );
}

export function activationHelperSpawnArguments(
  command,
  args,
  options,
  env,
  diagnosticsEnabled,
  probeUrl,
) {
  return diagnosticsEnabled && isExactActivationHelperInvocation(command, args, options, env)
    ? ['--import', probeUrl, ...args]
    : args;
}
