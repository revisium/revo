import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { RevoCoreRuntime } from '@revisium/revo-core/runtime';

type AdminApp = Pick<RevoCoreRuntime['app'], 'useStaticAssets' | 'use'>;

interface AdminRequest {
  readonly method: string;
  readonly path: string;
  accepts(type: string): string | false | string[];
}

interface AdminResponse {
  status(code: number): { end(): void };
  sendFile(
    filePath: string,
    options: { readonly root: string },
    callback: (error?: Error) => void,
  ): void;
}

const reservedPrefixes = ['/api', '/graphql', '/health', '/mcp', '/system', '/assets'] as const;

function isReservedPath(requestPath: string): boolean {
  return reservedPrefixes.some(
    (prefix) => requestPath === prefix || requestPath.startsWith(`${prefix}/`),
  );
}

function hasExtension(requestPath: string): boolean {
  return (requestPath.split('/').pop() ?? '').includes('.');
}

function acceptsHtml(request: AdminRequest): boolean {
  const accepted = request.accepts('html');
  if (accepted === false) {
    return false;
  }
  if (typeof accepted === 'string') {
    return accepted === 'html' || accepted === 'text/html';
  }
  return accepted.includes('html') || accepted.includes('text/html');
}

function shouldServeFallback(request: AdminRequest): boolean {
  return (
    (request.method === 'GET' || request.method === 'HEAD') &&
    acceptsHtml(request) &&
    !hasExtension(request.path) &&
    !isReservedPath(request.path)
  );
}

function isAssetPath(requestPath: string): boolean {
  return requestPath === '/assets' || requestPath.startsWith('/assets/');
}

type AdminRuntime = Pick<RevoCoreRuntime, 'configureAfterCoreRoutes'>;

export async function configureAdminSpa(runtime: AdminRuntime): Promise<void> {
  const clientDirectory = await resolveAdminClientDirectory();
  runtime.configureAfterCoreRoutes((app) => mountAdminSpa(app, clientDirectory));
}

export async function resolveAdminClientDirectory(): Promise<string> {
  const { getRevoAdminClientDirectory } = await import('@revisium/revo-admin/runtime');
  const clientDirectory = getRevoAdminClientDirectory();
  try {
    const [directory, index, assets] = await Promise.all([
      stat(clientDirectory),
      stat(path.join(clientDirectory, 'index.html')),
      stat(path.join(clientDirectory, 'assets')),
    ]);
    if (!directory.isDirectory() || !index.isFile() || !assets.isDirectory()) {
      throw new Error('invalid Admin client layout');
    }
  } catch {
    throw new Error('Revo Admin client assets are unavailable');
  }
  return clientDirectory;
}

export function mountAdminSpa(app: AdminApp, clientDirectory: string): void {
  app.useStaticAssets(clientDirectory, { index: false });
  app.use((request: AdminRequest, response: AdminResponse, next: () => void) => {
    if (isAssetPath(request.path)) {
      response.status(404).end();
      return;
    }
    if (!shouldServeFallback(request)) {
      next();
      return;
    }
    response.sendFile('index.html', { root: clientDirectory }, (error) => {
      if (error) {
        next();
      }
    });
  });
}
