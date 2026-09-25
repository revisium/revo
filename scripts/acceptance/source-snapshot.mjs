import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

export const REQUIRED_SOURCE_FILES = [
  '.nvmrc',
  'LICENSE',
  'README.md',
  'installer/bootstrap-entry.mjs',
  'installer/build-installer.mjs',
  'installer/build-payload.mjs',
  'installer/install-session.mjs',
  'installer/install.sh.in',
  'installer/lib/node-platform.mjs',
  'installer/lib/release-metadata.mjs',
  'installer/node-bootstrap.mjs',
  'installer/probe-diagnostic.mjs',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/build-release-bundle.mjs',
  'src/bin/revo.ts',
  'tsconfig.build.json',
  'tsconfig.json',
];

const HASH = (bytes) => createHash('sha256').update(bytes).digest('hex');
const comparePaths = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const MODE_DIRECTORY = 0o700;
const MODE_FILE = 0o600;
const CURRENT_UID = typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;

function fail(message) {
  throw new Error(`acceptance source snapshot: ${message}`);
}

function allowed(path) {
  return REQUIRED_SOURCE_FILES.includes(path) || (path.startsWith('src/') && path.endsWith('.ts'));
}

function validateInventoryPath(path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.includes('\\') ||
    path.includes('\0') ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    posix.normalize(path) !== path
  ) {
    fail('inventory contains an unsafe relative path');
  }
  if (!allowed(path)) {
    fail(`inventory path is outside the build-input policy: ${path}`);
  }
  return path;
}

function gitInventory(root) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['ls-files', '--cached', '-z'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4096) {
        stderr = stderr.slice(-4096);
      }
    });
    child.once('error', () =>
      rejectPromise(new Error('acceptance source snapshot: Git inventory is unavailable')),
    );
    child.once('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        rejectPromise(
          new Error(
            `acceptance source snapshot: Git inventory failed${stderr ? `: ${stderr.trim()}` : ''}`,
          ),
        );
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString('utf8').split('\0').filter(Boolean));
    });
  });
}

async function productionSources(root) {
  const result = [];
  const visit = async (directory) => {
    const before = await lstat(directory, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      fail('production source tree contains a non-directory object');
    }
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        const info = await lstat(path, { bigint: true });
        if (info.isSymbolicLink()) {
          fail('production source tree contains a symbolic link');
        }
        if (info.isDirectory()) {
          await visit(path);
        } else if (info.isFile()) {
          if (!entry.isFile()) {
            fail('production source tree changed during inventory');
          }
          if (entry.name.endsWith('.ts')) {
            result.push(relative(root, path).split(sep).join('/'));
          }
        } else {
          fail('production source tree contains a special file');
        }
      }),
    );
    const after = await lstat(directory, { bigint: true });
    if (!sameSourceDirectory(before, after)) {
      fail('production source directory changed during inventory');
    }
  };
  const sourceRoot = join(root, 'src');
  const info = await lstat(sourceRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail('src must be a real directory');
  }
  await visit(sourceRoot);
  return result.sort(comparePaths);
}

function sameSourceObject(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function sameSourceDirectory(left, right) {
  return (
    sameSourceObject(left, right) &&
    left.isDirectory() &&
    right.isDirectory() &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameSourceFile(left, right) {
  return (
    sameSourceObject(left, right) &&
    left.isFile() &&
    right.isFile() &&
    left.nlink === 1n &&
    right.nlink === 1n &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameOutputObject(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function assertOwner(info, description) {
  if (CURRENT_UID === undefined || info.uid !== CURRENT_UID) {
    fail(`${description} must be owned by the current user`);
  }
}

function isTrustedParentMode(path, info) {
  const mode = info.mode & 0o7777n;
  if ((mode & 0o022n) === 0n) {
    return true;
  }
  const sharedTemporaryDirectories = new Set([
    '/tmp',
    '/var/tmp',
    '/private/tmp',
    '/private/var/tmp',
  ]);
  return sharedTemporaryDirectories.has(path) && info.uid === 0n && (mode & 0o1777n) === 0o1777n;
}

function absoluteAncestors(path) {
  const absolute = resolve(path);
  const parsedRoot = resolve(sep);
  const components = relative(parsedRoot, absolute).split(sep).filter(Boolean);
  const result = [parsedRoot];
  let current = parsedRoot;
  for (const component of components) {
    current = join(current, component);
    result.push(current);
  }
  return result;
}

async function inspectOutputParent(path) {
  const canonical = await realpath(path);
  const ancestors = absoluteAncestors(canonical);
  const chain = await Promise.all(
    ancestors.map(async (directory) => {
      const info = await lstat(directory, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) {
        fail('output parent chain contains a non-directory');
      }
      if (info.uid !== 0n && info.uid !== CURRENT_UID) {
        fail('output parent has an untrusted owner');
      }
      if (!isTrustedParentMode(directory, info)) {
        fail('output parent is writable by an untrusted user');
      }
      return { path: directory, info };
    }),
  );
  return { path: canonical, chain };
}

async function assertOutputParentStable(parent) {
  await Promise.all(
    parent.chain.map(async (expected) => {
      const current = await lstat(expected.path, { bigint: true });
      if (!sameOutputObject(expected.info, current) || !current.isDirectory()) {
        fail('output parent identity changed');
      }
      if (!isTrustedParentMode(expected.path, current)) {
        fail('output parent permissions changed');
      }
    }),
  );
}

function assertPrivateOutputDirectory(info, path) {
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail('output must be a real directory');
  }
  assertOwner(info, 'output directory');
  if ((info.mode & 0o7777n) !== BigInt(MODE_DIRECTORY)) {
    fail(`output directory must have mode 0700: ${path}`);
  }
}

export async function collectSourceFiles({ root, inventory }) {
  const sourceRoot = await realpath(root);
  if (inventory !== undefined && !Array.isArray(inventory)) {
    fail('explicit inventory must be a list of relative paths');
  }
  const candidates = inventory ?? (await gitInventory(sourceRoot)).filter(allowed);
  const result = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const path = validateInventoryPath(candidate);
    if (seen.has(path)) {
      fail(`inventory contains a duplicate path: ${path}`);
    }
    seen.add(path);
    result.push(path);
  }
  for (const required of REQUIRED_SOURCE_FILES) {
    if (!seen.has(required)) {
      fail(`inventory is missing a required build input: ${required}`);
    }
  }
  for (const required of await productionSources(sourceRoot)) {
    if (!seen.has(required)) {
      fail(`inventory is missing a production source file: ${required}`);
    }
  }
  return result.sort(comparePaths);
}

function isWithin(parent, target) {
  const path = relative(parent, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function inspectSourcePath(root, path, rootIdentity) {
  const parts = path.split('/');
  let current = root;
  const chain = [{ path: root, info: rootIdentity }];
  let leaf;
  // Each parent must be confirmed before resolving the next path component.
  // oxlint-disable no-await-in-loop -- the path chain is intentionally checked in ancestor order.
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink()) {
      fail(`source path contains a symbolic link: ${path}`);
    }
    if (index < parts.length - 1 && !info.isDirectory()) {
      fail(`source path has a non-directory parent: ${path}`);
    }
    if (index === parts.length - 1 && !info.isFile()) {
      fail(`source path is not a regular file: ${path}`);
    }
    if (index === parts.length - 1 && info.nlink !== 1n) {
      fail(`source file has multiple hard links: ${path}`);
    }
    if (index < parts.length - 1) {
      chain.push({ path: current, info });
    } else {
      leaf = info;
    }
  }
  // oxlint-enable no-await-in-loop
  return { leafPath: current, leaf, chain };
}

async function assertSourceChainStable(chain, path) {
  await Promise.all(
    chain.map(async (expected) => {
      const current = await lstat(expected.path, { bigint: true });
      if (!sameSourceDirectory(expected.info, current)) {
        fail(`source directory identity changed while snapshotting: ${path}`);
      }
    }),
  );
}

async function readSourceFile(root, path, rootIdentity, testHooks) {
  const source = await inspectSourcePath(root, path, rootIdentity);
  if (constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined) {
    fail('safe no-follow nonblocking file opens are unavailable on this platform');
  }
  await assertSourceChainStable(source.chain, path);
  const leafBeforeOpen = await lstat(source.leafPath, { bigint: true });
  if (!sameSourceFile(source.leaf, leafBeforeOpen)) {
    fail(`source changed before open: ${path}`);
  }
  await testHooks.beforeSourceOpen?.(path);
  const handle = await open(
    source.leafPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameSourceFile(source.leaf, opened)) {
      fail(`source changed while opening: ${path}`);
    }
    await assertSourceChainStable(source.chain, path);
    const beforeRead = await lstat(source.leafPath, { bigint: true });
    if (!sameSourceFile(opened, beforeRead)) {
      fail(`source changed before read: ${path}`);
    }
    await testHooks.beforeSourceRead?.(path);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(source.leafPath, { bigint: true });
    if (!sameSourceFile(opened, after) || !sameSourceFile(opened, afterPath)) {
      fail(`source changed while snapshotting: ${path}`);
    }
    await assertSourceChainStable(source.chain, path);
    if (BigInt(bytes.length) !== opened.size) {
      fail(`source byte count changed while snapshotting: ${path}`);
    }
    return { bytes, chain: source.chain, leafPath: source.leafPath, leaf: source.leaf };
  } finally {
    await handle.close();
  }
}

async function ensureOutput({ path, parent, testHooks }) {
  await assertOutputParentStable(parent);
  let info;
  let existed = false;
  try {
    info = await lstat(path, { bigint: true });
    existed = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  if (existed) {
    assertPrivateOutputDirectory(info, path);
    if ((await readdir(path)).length !== 0) {
      fail('existing output directory must be empty');
    }
  } else {
    await testHooks.beforeOutputCreate?.(path);
    await assertOutputParentStable(parent);
    await mkdir(path, { mode: MODE_DIRECTORY });
    info = await lstat(path, { bigint: true });
    assertPrivateOutputDirectory(info, path);
  }
  await assertOutputParentStable(parent);
  return { path, info, parent };
}

async function assertOutputDirectoriesStable(directories) {
  await Promise.all(
    [...directories].map(async ([path, expected]) => {
      const current = await lstat(path, { bigint: true });
      if (!sameOutputObject(expected, current) || !current.isDirectory()) {
        fail('output directory identity changed');
      }
      assertPrivateOutputDirectory(current, path);
    }),
  );
}

async function ensureOutputSubdirectories(output, parentParts, directories) {
  let parentPath = output.path;
  // Output parents must be created and verified from shallowest to deepest.
  // oxlint-disable no-await-in-loop -- sequential directory creation is required for safe parent checks.
  for (const part of parentParts) {
    await assertOutputParentStable(output.parent);
    await assertOutputDirectoriesStable(directories);
    const path = join(parentPath, part);
    if (!directories.has(path)) {
      let existing;
      try {
        existing = await lstat(path, { bigint: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      }
      if (existing !== undefined) {
        fail('unexpected output subdirectory already exists');
      }
      await mkdir(path, { mode: MODE_DIRECTORY });
      const info = await lstat(path, { bigint: true });
      assertPrivateOutputDirectory(info, path);
      directories.set(path, info);
    }
    parentPath = path;
  }
  // oxlint-enable no-await-in-loop
  return parentPath;
}

async function writeOutputFile(path, bytes) {
  if (constants.O_NOFOLLOW === undefined) {
    fail('safe no-follow output opens are unavailable on this platform');
  }
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    MODE_FILE,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== CURRENT_UID) {
      fail('output file identity is invalid');
    }
    if ((before.mode & 0o7777n) !== BigInt(MODE_FILE) || before.size !== 0n) {
      fail('output file must start empty with mode 0600');
    }
    await handle.writeFile(bytes);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    if (
      !sameSourceObject(before, after) ||
      after.nlink !== 1n ||
      after.size !== BigInt(bytes.length) ||
      (after.mode & 0o7777n) !== BigInt(MODE_FILE)
    ) {
      fail('output file changed while writing');
    }
    return after;
  } finally {
    await handle.close();
  }
}

async function readOutputFile(path, expectedIdentity) {
  if (constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined) {
    fail('safe no-follow nonblocking output opens are unavailable on this platform');
  }
  const before = await lstat(path, { bigint: true });
  if (!sameSourceFile(expectedIdentity, before)) {
    fail('output file identity changed after writing');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !sameSourceFile(before, opened) ||
      !sameSourceFile(expectedIdentity, opened) ||
      opened.uid !== CURRENT_UID ||
      (opened.mode & 0o7777n) !== BigInt(MODE_FILE)
    ) {
      fail('output file identity or permissions changed');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (
      !sameSourceFile(opened, after) ||
      !sameSourceFile(opened, afterPath) ||
      BigInt(bytes.length) !== opened.size
    ) {
      fail('output file changed while verifying');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function inspectOutputTree(output, expectedFiles, directories) {
  const actualFiles = [];
  const actualDirectories = [];
  const visit = async (directory, relativeDirectory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const info = await lstat(path, { bigint: true });
        if (info.isSymbolicLink()) {
          fail('output contains a symbolic link');
        }
        if (info.isDirectory()) {
          assertPrivateOutputDirectory(info, path);
          actualDirectories.push(path);
          await visit(path, relativePath);
        } else if (info.isFile()) {
          assertOwner(info, 'output file');
          const expectedIdentity = expectedFiles.get(relativePath);
          if (
            expectedIdentity === undefined ||
            !sameSourceFile(expectedIdentity, info) ||
            info.nlink !== 1n ||
            (info.mode & 0o7777n) !== BigInt(MODE_FILE)
          ) {
            fail('output file must have one link and mode 0600');
          }
          actualFiles.push(relativePath);
        } else {
          fail('output contains a special file');
        }
      }),
    );
  };
  await visit(output.path, '');
  actualFiles.sort(comparePaths);
  actualDirectories.sort(comparePaths);
  const expectedDirectoryPaths = [...directories.keys()]
    .filter((path) => path !== output.path)
    .sort(comparePaths);
  if (
    JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles.keys()].sort(comparePaths)) ||
    JSON.stringify(actualDirectories) !== JSON.stringify(expectedDirectoryPaths)
  ) {
    fail('output file inventory changed while snapshotting');
  }
}

export async function createSourceSnapshot({ root, output, files, testHooks = {} }) {
  const sourceRoot = await realpath(root);
  const rootIdentity = await lstat(sourceRoot, { bigint: true });
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) {
    fail('source root must be a real directory');
  }
  const outputParent = await inspectOutputParent(dirname(resolve(output)));
  const outputName = basename(resolve(output));
  if (outputName === '' || outputName === '.' || outputName === '..') {
    fail('output directory name is invalid');
  }
  const canonicalOutput = join(outputParent.path, outputName);
  if (isWithin(sourceRoot, canonicalOutput)) {
    fail('output must be outside the source tree');
  }
  const inventory = await collectSourceFiles({ root: sourceRoot, inventory: files });
  await testHooks.afterInventory?.(inventory);
  const contents = [];
  // oxlint-disable no-await-in-loop -- sequential reads are intentional so a later read can expose mutation of an earlier source.
  for (const path of inventory) {
    contents.push({ path, ...(await readSourceFile(sourceRoot, path, rootIdentity, testHooks)) });
  }
  // oxlint-enable no-await-in-loop
  const expectedProductionSources = inventory.filter(
    (path) => path.startsWith('src/') && path.endsWith('.ts'),
  );
  const currentProductionSources = await productionSources(sourceRoot);
  if (JSON.stringify(currentProductionSources) !== JSON.stringify(expectedProductionSources)) {
    fail('production source inventory changed while snapshotting');
  }
  await Promise.all(
    contents.map(async ({ path, leafPath, leaf, chain }) => {
      await assertSourceChainStable(chain, path);
      const current = await lstat(leafPath, { bigint: true });
      if (!sameSourceFile(leaf, current)) {
        fail(`source changed before staging: ${path}`);
      }
    }),
  );

  const outputState = await ensureOutput({
    path: canonicalOutput,
    parent: outputParent,
    testHooks,
  });
  const outputDirectories = new Map([[outputState.path, outputState.info]]);
  const outputFiles = new Map();
  // oxlint-disable no-await-in-loop -- create/verify/write operations depend on the output directory chain and preserve partial evidence on failure.
  for (const { path, bytes } of contents) {
    await testHooks.beforeOutputWrite?.(path);
    await assertOutputParentStable(outputState.parent);
    await assertOutputDirectoriesStable(outputDirectories);
    const pathParts = path.split('/');
    const destinationDirectory = await ensureOutputSubdirectories(
      outputState,
      pathParts.slice(0, -1),
      outputDirectories,
    );
    await assertOutputParentStable(outputState.parent);
    await assertOutputDirectoriesStable(outputDirectories);
    const destination = join(destinationDirectory, pathParts.at(-1));
    outputFiles.set(path, await writeOutputFile(destination, bytes));
  }
  // oxlint-enable no-await-in-loop
  await assertOutputParentStable(outputState.parent);
  await assertOutputDirectoriesStable(outputDirectories);
  await inspectOutputTree(
    outputState,
    new Map(inventory.map((path) => [path, outputFiles.get(path)])),
    outputDirectories,
  );
  await Promise.all(
    contents.map(async ({ path, bytes }) => {
      const written = await readOutputFile(
        join(outputState.path, ...path.split('/')),
        outputFiles.get(path),
      );
      if (!written.equals(bytes)) {
        fail(`output bytes differ from source: ${path}`);
      }
    }),
  );
  await testHooks.beforeFinalOutputCheck?.();
  await assertOutputParentStable(outputState.parent);
  await assertOutputDirectoriesStable(outputDirectories);
  await inspectOutputTree(
    outputState,
    new Map(inventory.map((path) => [path, outputFiles.get(path)])),
    outputDirectories,
  );
  return {
    files: contents.map(({ path, bytes }) => ({ path, sha256: HASH(bytes) })),
  };
}
