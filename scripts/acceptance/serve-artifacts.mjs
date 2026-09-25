#!/usr/bin/env node
// oxlint-disable curly -- compact route validation keeps the acceptance helper auditable.

// Strict loopback HTTPS server for the acceptance bundle and one exact TUI tarball.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { basename, isAbsolute, relative, resolve } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/u;

const fail = (message) => {
  throw new Error(`acceptance server: ${message}`);
};

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      console.log(
        'Usage: node scripts/acceptance/serve-artifacts.mjs --key FILE --certificate FILE --bundle-root DIR --tui-tarball FILE --tui-sha256 SHA256 [--port PORT]',
      );
      process.exit(0);
    }
    if (!argument?.startsWith('--')) fail(`unknown argument ${argument}`);
    const name = argument.slice(2);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) fail(`missing value for --${name}`);
    values.set(name, value);
  }
  const required = ['key', 'certificate', 'bundle-root', 'tui-tarball', 'tui-sha256'];
  for (const name of required)
    if (typeof values.get(name) !== 'string') fail(`--${name} is required`);
  const port = Number(values.get('port') ?? 8443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('port is invalid');
  const tuiSha256 = values.get('tui-sha256');
  if (!SHA256.test(tuiSha256)) fail('TUI SHA256 is invalid');
  return {
    key: resolve(values.get('key')),
    certificate: resolve(values.get('certificate')),
    bundleRoot: resolve(values.get('bundle-root')),
    tuiTarball: resolve(values.get('tui-tarball')),
    tuiSha256,
    port,
  };
}

function inside(root, candidate) {
  const value = relative(root, candidate);
  return (
    value === '' ||
    (!value.startsWith('..') &&
      !value.includes(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      !isAbsolute(value))
  );
}

async function regularFile(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) fail(`unsafe artifact path: ${path}`);
  return info;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const tuiName = basename(options.tuiTarball);
  await regularFile(options.tuiTarball);
  const tuiBytes = await readFile(options.tuiTarball);
  const actual = createHash('sha256').update(tuiBytes).digest('hex');
  if (actual !== options.tuiSha256) fail('TUI tarball digest mismatch');
  await regularFile(options.key);
  await regularFile(options.certificate);
  const bundleRoot = resolve(options.bundleRoot);
  const requestHandler = async (request, response) => {
    console.error(`${request.method ?? 'UNKNOWN'} ${request.url ?? ''}`);
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' });
        response.end();
        return;
      }
      const url = new URL(request.url ?? '/', 'https://localhost');
      let artifactPath;
      if (
        url.pathname === `/tui/${options.tuiSha256}/${tuiName}` &&
        url.search === `?sha256=${options.tuiSha256}`
      ) {
        artifactPath = options.tuiTarball;
      } else if (url.pathname.startsWith('/revo/channels/')) {
        const match = /^\/revo\/channels\/(stable|alpha)\.json$/u.exec(url.pathname);
        if (!match) {
          response.writeHead(404);
          response.end();
          return;
        }
        artifactPath = resolve(bundleRoot, 'channel.json');
      } else if (url.pathname.startsWith('/revo/releases/')) {
        const match = /^\/revo\/releases\/([^/]+)\/(.+)$/u.exec(url.pathname);
        if (!match || match[2].includes('..') || match[2].includes('\\')) {
          response.writeHead(400);
          response.end();
          return;
        }
        artifactPath = resolve(bundleRoot, match[2]);
      } else {
        response.writeHead(404);
        response.end();
        return;
      }
      const isExactTui = artifactPath === options.tuiTarball;
      if (!isExactTui && !inside(bundleRoot, artifactPath)) {
        response.writeHead(400);
        response.end();
        return;
      }
      const info = await regularFile(artifactPath);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': info.size,
        'content-type': artifactPath.endsWith('.json')
          ? 'application/json'
          : artifactPath.endsWith('.tgz')
            ? 'application/gzip'
            : 'application/octet-stream',
      });
      if (request.method === 'HEAD') response.end();
      else createReadStream(artifactPath).pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(404);
      if (!response.writableEnded) response.end();
    }
  };
  const server = createServer(
    { key: await readFile(options.key), cert: await readFile(options.certificate) },
    (request, response) => {
      void requestHandler(request, response).catch((error) => {
        console.error(error?.stack ?? String(error));
        if (!response.headersSent) response.writeHead(500);
        if (!response.writableEnded) response.end();
      });
    },
  );
  server.on('error', (error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
  server.listen(options.port, '127.0.0.1', () => {
    process.stdout.write(
      `${JSON.stringify({ port: options.port, tuiSha256: options.tuiSha256 })}\n`,
    );
  });
  const close = () => server.close(() => process.exit(0));
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

try {
  await main();
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
}
