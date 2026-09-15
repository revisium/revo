// oxlint-disable curly -- generated payload builder keeps guarded output compact

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'rolldown';

const ROOT = dirname(fileURLToPath(import.meta.url));

export async function buildPayload({ entry = resolve(ROOT, 'bootstrap-entry.mjs') } = {}) {
  const bundle = await build({
    input: entry,
    external: [/^node:/u],
    write: false,
    output: { format: 'esm', comments: false },
  });
  const output = bundle.output?.[0];
  if (output?.type !== 'chunk' || typeof output.code !== 'string')
    throw new Error('Payload bundler did not produce one ESM chunk.');
  return output.code;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(await buildPayload());
}
