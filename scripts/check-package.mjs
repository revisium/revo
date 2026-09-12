import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const expectedFiles = [
  'LICENSE',
  'README.md',
  'dist/bin/revo.d.ts',
  'dist/bin/revo.js',
  'dist/bin/revo.js.map',
  'dist/foundation-cli.d.ts',
  'dist/foundation-cli.js',
  'dist/foundation-cli.js.map',
  'dist/layout.d.ts',
  'dist/layout.js',
  'dist/layout.js.map',
  'dist/release-metadata.d.ts',
  'dist/release-metadata.js',
  'dist/release-metadata.js.map',
  'package.json',
];

const packageMetadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
if (packageMetadata.private !== true) {
  throw new Error('Foundation package must remain private to prevent accidental publication');
}
if (packageMetadata.scripts?.prepublishOnly !== 'node scripts/refuse-publish.mjs') {
  throw new Error('Foundation package must keep its prepublishOnly publication guard');
}

const cliVersion = execFileSync(process.execPath, ['dist/bin/revo.js', '--version'], {
  encoding: 'utf8',
}).trim();
if (cliVersion !== packageMetadata.version) {
  throw new Error('The revo binary must report the version from package.json');
}

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
});
const report = JSON.parse(output);
const actualFiles = report[0].files.map(({ path }) => path).sort();

if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(
    `Package contents differ from the exact allowlist.\nExpected: ${expectedFiles.join(', ')}\nActual: ${actualFiles.join(', ')}`,
  );
}

console.log(`Package dry run contains exactly ${actualFiles.length} approved files.`);
