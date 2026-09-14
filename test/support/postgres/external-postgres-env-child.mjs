import { Client } from 'pg';

import { buildExternalPostgresClientConfig } from '../../../dist/postgres/index.js';

const client = new Client(buildExternalPostgresClientConfig(process.argv[2]));
client.on('error', () => undefined);
try {
  await client.connect();
  const result = await client.query('SELECT current_database() AS database');
  process.stdout.write(JSON.stringify({ kind: 'ready', database: result.rows[0]?.database }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({ kind: 'failed', name: error instanceof Error ? error.name : typeof error }),
  );
} finally {
  await client.end().catch(() => undefined);
}
