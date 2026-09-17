// oxlint-disable curly, no-unsafe-type-assertion, no-non-null-assertion -- compact bounded archive fixture

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  createPackageInstallPlan,
  type PackageInstallPlan,
} from '../../../src/installation/package-install-plan.js';
import { packageReleaseFixture } from './package-release-fixture.js';

const hash = (bytes: Uint8Array, algorithm: 'sha256' | 'sha512'): string =>
  createHash(algorithm).update(bytes).digest('hex');
const sri = (bytes: Uint8Array): string =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const header = (name: string, size: number, type: '0' | '5'): Uint8Array => {
  const value = Buffer.alloc(512);
  value.write(name, 0, 100, 'utf8');
  value.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  value[156] = type.charCodeAt(0);
  value.write('ustar\0', 257, 6, 'ascii');
  value.fill(32, 148, 156);
  const checksum = [...value].reduce((sum, byte) => sum + byte, 0);
  value.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return value;
};
export function tarFixture(files: Record<string, string>, gzip = true): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content);
    parts.push(header(name, bytes.length, name.endsWith('/') ? '5' : '0'));
    if (!name.endsWith('/')) {
      parts.push(bytes);
      if (bytes.length % 512) parts.push(Buffer.alloc(512 - (bytes.length % 512)));
    }
  }
  parts.push(Buffer.alloc(1024));
  const tar = Buffer.concat(parts);
  return gzip ? gzipSync(tar) : tar;
}

export async function packageArtifactScenario(
  options: {
    readonly channel?: 'stable' | 'alpha';
    readonly version?: string;
    readonly unsafeTar?: Uint8Array;
    readonly activationProbe?: boolean;
    readonly workspace?: string;
  } = {},
) {
  const fixture = packageReleaseFixture(
    options.channel === undefined && options.version === undefined
      ? {}
      : {
          ...(options.channel === undefined ? {} : { channel: options.channel }),
          ...(options.version === undefined ? {} : { version: options.version }),
        },
  );
  const release = fixture.manifest.release;
  const packageJson = JSON.stringify({
    name: '@revisium/revo',
    version: release.version,
    packageManager: `pnpm@${fixture.request.toolchain.pnpm}`,
    ...(options.activationProbe ? { bin: { revo: 'dist/bin/revo.js' } } : {}),
    dependencies: {
      '@revisium/revo-core': fixture.request.components.core.version,
      '@revisium/revo-admin': fixture.request.components.admin.version,
    },
  });
  const workspace = `packages:\n  - packages/*\nallowBuilds:\n  - @revisium/revo-core@${fixture.request.components.core.version}\n`;
  const bytes = {
    package:
      options.unsafeTar ??
      tarFixture({
        'package/': '',
        'package/package.json': packageJson,
        'package/dist/index.js': 'export {}\n',
        ...(options.activationProbe
          ? {
              'package/dist/bin/revo.js':
                "import { appendFile } from 'node:fs/promises';\nif (process.env.REVO_ACTIVATION_EXIT7) process.exit(7);\nif (process.env.REVO_ACTIVATION_TERM) process.kill(process.pid, 'SIGTERM');\nawait appendFile(process.env.REVO_ACTIVATION_OUTPUT, JSON.stringify({ execPath: process.execPath, argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\n",
            }
          : {}),
      }),
    packageJson: Buffer.from(packageJson),
    pnpmLock: Buffer.from('lockfileVersion: 9.0\n\nimporters:\n  .: {}\n'),
    pnpmWorkspace: Buffer.from(options.workspace ?? workspace),
  };
  const artifacts = Object.fromEntries(
    Object.entries(bytes).map(([name, value]) => [
      name,
      {
        url: fixture.manifest.artifacts[name as keyof typeof bytes].url,
        sha256: hash(value, 'sha256'),
        ...(name === 'package' ? { integrity: sri(value) } : {}),
      },
    ]),
  ) as typeof fixture.manifest.artifacts;
  const plan: PackageInstallPlan = createPackageInstallPlan({
    manifest: { ...fixture.manifest, artifacts },
    request: fixture.request,
  });
  const scratch = await mkdtemp(join('/tmp', 'revo-package-artifacts-'));
  const request = async (url: string, _init?: { readonly signal: AbortSignal }) => ({
    status: 200,
    headers: new Headers({
      'content-length': String(
        Object.entries(plan.artifacts).find(([, descriptor]) => descriptor.url === url)?.[0]
          ? bytes[
              Object.entries(plan.artifacts).find(
                ([, descriptor]) => descriptor.url === url,
              )![0] as keyof typeof bytes
            ].length
          : 0,
      ),
    }),
    body: (async function* () {
      const entry = Object.entries(plan.artifacts).find(([, descriptor]) => descriptor.url === url);
      yield bytes[entry?.[0] as keyof typeof bytes];
    })(),
  });
  return {
    plan,
    bytes,
    scratch,
    request,
    cleanup: () => rm(scratch, { recursive: true, force: true }),
  };
}
