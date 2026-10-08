import { afterEach, describe, expect, it } from 'vitest';

import { protectDatabaseUrl, redactLog } from '../../src/server-logs/log-redaction.js';
import { RevoConsoleLogger } from '../../src/server-logs/revo-console-logger.js';
import { CapturedOutput } from '../support/server-logs/captured-output.js';

describe('server log redaction', () => {
  it('redacts a protected database password in raw, URL-encoded, and URL forms', () => {
    const password = 'p@ss/w0rd?&x';
    const url = `postgresql://revo:${encodeURIComponent(password)}@db.example:5432/revo`;
    protectDatabaseUrl(url);

    const redacted = redactLog(
      [`connecting to ${url}`, `raw ${password}`, `encoded ${encodeURIComponent(password)}`].join(
        '\n',
      ),
    );

    expect(redacted).not.toContain('p@ss');
    expect(redacted).not.toContain('p%40ss');
    expect(redacted).toContain('connecting to postgresql://revo:[REDACTED]@db.example:5432/revo');
  });

  it('redacts a protected password whole when it contains the URL userinfo separator', () => {
    protectDatabaseUrl('postgresql://revo:tail@secret-9@db.example:5432/revo');

    const redacted = redactLog(
      'connecting to postgresql://revo:tail@secret-9@db.example:5432/revo',
    );

    expect(redacted).not.toContain('secret-9');
    expect(redacted).toBe('connecting to postgresql://revo:[REDACTED]@db.example:5432/revo');
  });

  it('redacts credentials of any database URL and password assignment', () => {
    const redacted = redactLog(
      [
        'postgres://user:unprotected@host/db',
        'host=db password=hunter22 user=revo',
        'PGPASSWORD=s3cr3t-value',
        '{"password":"json-secret"}',
      ].join('\n'),
    );

    for (const secret of ['unprotected', 'hunter22', 's3cr3t-value', 'json-secret']) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('postgres://user:[REDACTED]@host/db');
  });

  it('leaves ordinary diagnostics unchanged', () => {
    const line = 'Database start failed: password authentication failed for user "postgres"';

    expect(redactLog(line)).toBe(line);
  });
});

describe('Revo console logger', () => {
  let output: CapturedOutput | undefined;
  afterEach(() => {
    output?.restore();
    output = undefined;
  });

  it('writes plain redacted lines and stack traces without colors', () => {
    protectDatabaseUrl('postgresql://postgres:generated-pass-1234@127.0.0.1:5432/revo');
    output = new CapturedOutput();
    const logger = new RevoConsoleLogger();

    logger.error(
      'Core failed for postgresql://postgres:generated-pass-1234@127.0.0.1:5432/revo',
      'Error: generated-pass-1234 rejected\n    at connect (pg.js:1:1)',
      'CoreHost',
    );
    logger.warn('plain warning', 'ServerOwner');

    const text = output.text();
    expect(text).not.toContain('generated-pass-1234');
    expect(text).not.toContain('\u001b[');
    expect(text).toMatch(
      /ERROR \[CoreHost\] Core failed for postgresql:\/\/postgres:\[REDACTED\]@/u,
    );
    expect(text).toContain('Error: [REDACTED] rejected\n    at connect (pg.js:1:1)');
    expect(text).toMatch(/WARN \[ServerOwner\] plain warning/u);
  });
});
