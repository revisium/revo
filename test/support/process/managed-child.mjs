import { writeFile } from 'node:fs/promises';

const [mode, value] = process.argv.slice(2);

if (mode === 'environment') {
  process.stdout.write(
    JSON.stringify({ cwd: process.cwd(), env: process.env, argv: process.argv.slice(3) }),
  );
} else if (mode === 'exit') {
  process.exitCode = Number(value);
} else if (mode === 'marker') {
  await writeFile(String(value), 'spawned');
} else if (mode === 'term') {
  process.on('SIGTERM', () => process.exit(0));
  process.on('message', () => process.send({ state: 'ready' }));
} else if (mode === 'resist') {
  process.on('SIGTERM', () => process.send({ state: 'term-received' }));
  process.on('message', () => process.send({ state: 'ready' }));
}
