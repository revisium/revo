import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureAdminSpa } from '../../src/admin/admin-spa.js';
import { AdminSpaScenario } from '../support/admin/admin-spa-scenario.js';

const resources: string[] = [];
const scenarios: AdminSpaScenario[] = [];
afterEach(async () => {
  const cleanupResults = await Promise.allSettled(scenarios.map((scenario) => scenario.close()));
  const cleanupErrors = cleanupResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Admin scenario cleanup failed');
  }
  scenarios.splice(0);
  await Promise.all(
    resources.splice(0).map((resource) => rm(resource, { recursive: true, force: true })),
  );
});

describe('Admin SPA HTTP contract', () => {
  it('serves navigation and real assets while preserving backend-like paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'revo-admin-'));
    resources.push(directory);
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'assets', 'app.js'), 'console.log(1)');
    const scenario = new AdminSpaScenario();
    scenarios.push(scenario);
    await scenario.setup(directory);
    const url = await scenario.listen();
    await expect(
      fetch(`${url}/dialogues`, { headers: { accept: 'text/html' } }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(fetch(`${url}/assets/app.js`)).resolves.toMatchObject({ status: 200 });
    await expect(fetch(`${url}/graphql`)).resolves.toMatchObject({ status: 404 });
    await expect(fetch(`${url}/assets/missing.js`)).resolves.toMatchObject({ status: 404 });
    await expect(
      fetch(`${url}/dialogues`, { method: 'POST', headers: { accept: 'text/html' } }),
    ).resolves.toMatchObject({ status: 404 });
    await scenario.close();
  });

  it.each([
    ['/graphql', 'text/html'],
    ['/api/health', 'text/html'],
    ['/health', 'text/html'],
    ['/mcp', 'text/html'],
    ['/system/info', 'text/html'],
    ['/dialogues', 'application/json'],
    ['/favicon.ico', 'text/html'],
  ])('does not index %s for %s', async (path, accept) => {
    const directory = await mkdtemp(join(tmpdir(), 'revo-admin-'));
    resources.push(directory);
    const scenario = new AdminSpaScenario();
    scenarios.push(scenario);
    await scenario.setup(directory);
    const url = await scenario.listen();
    await expect(fetch(`${url}${path}`, { headers: { accept } })).resolves.toMatchObject({
      status: 404,
    });
    await scenario.close();
  });

  it('validates the published Admin client before installing the Core hook', async () => {
    const configured: unknown[] = [];
    await configureAdminSpa({
      configureAfterCoreRoutes: (configure) => configured.push(configure),
    });
    expect(configured).toHaveLength(1);
  });

  it('fails startup when the published client bundle is incomplete', async () => {
    vi.doMock('@revisium/revo-admin/runtime', () => ({
      getRevoAdminClientDirectory: () => join(tmpdir(), 'revo-admin-missing-bundle'),
    }));
    await expect(
      configureAdminSpa({
        configureAfterCoreRoutes: () => undefined,
      }),
    ).rejects.toThrow('Revo Admin client assets are unavailable');
    vi.doUnmock('@revisium/revo-admin/runtime');
  });
});
