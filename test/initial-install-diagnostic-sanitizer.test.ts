import { describe, expect, it } from 'vitest';

import {
  INITIAL_DIAGNOSTIC_OMITTED,
  sanitizeInitialDiagnostic,
  serializeInitialInstallFailureReceipt,
  type InitialDiagnosticCapture,
  type InitialInstallDiagnostics,
} from './support/installation/initial-install-diagnostic-sanitizer.js';

const complete = (text: string): InitialDiagnosticCapture => ({ status: 'complete', text });
const diagnostics = (diagnostic: string): InitialInstallDiagnostics => ({
  status: 'complete',
  reason: 'none',
  logs: {
    'install-session.log': { status: 'captured', sizeBytes: 10, diagnostic },
    'server-start.log': { status: 'captured', sizeBytes: 20, diagnostic },
    'activation-result.log': { status: 'captured', sizeBytes: 30, diagnostic },
  },
});

describe('initial install diagnostic sanitizer', () => {
  it.each([
    [
      'single userinfo',
      'failed https://alice:secret@example.invalid/a?q=hidden#fragment',
      'failed URL origin scheme=https host=example.invalid port=443',
    ],
    [
      'multiple at signs',
      'https://alice@realm:secret@example.invalid/path',
      'URL origin scheme=https host=example.invalid port=443',
    ],
    [
      'IPv6 and port',
      'connect https://[2001:db8::1]:8443/path',
      'connect URL origin scheme=https host=[2001:db8::1] port=8443',
    ],
    [
      'path, query, and fragment',
      'https://example.invalid/private?signature=secret#hidden',
      'URL origin scheme=https host=example.invalid port=443',
    ],
  ])('reduces %s to a safe origin', (_name, input, expected) => {
    const sanitized = sanitizeInitialDiagnostic(complete(input));
    expect(sanitized).toBe(expected);
    expect(sanitizeInitialDiagnostic(complete(sanitized))).toBe(expected);
  });

  it.each([
    'https://bad host/path',
    'https:// alice:secret@example.invalid/path',
    'https://\nalice:secret@example.invalid/path',
    'https://\r\nalice:secret@example.invalid/path',
    'https://',
    'https://example.invalid/path trailing',
    'https://user:secret @host/path',
    'https://user:secret@ host/path',
    'https://example.invalid/path https://other.invalid/secret',
    'https://example.invalid/%2fsecret',
    'https%3a%2f%2fexample.invalid/path',
    'https://example.invalid/%252fsecret',
    'https://example.invalid/%',
    'https://example.invalid/path`quoted`',
  ])('omits ambiguous URL %s', (input) => {
    expect(sanitizeInitialDiagnostic(complete(input))).toBe(INITIAL_DIAGNOSTIC_OMITTED);
  });

  it.each([
    'Authorization: Bearer secret-value',
    'Bearer secret-value',
    'basic dXNlcjpwYXNz',
    'password=secret-value\ncontinued secret-value',
    'cookie: session=secret-value',
    'api_key=secret-value',
    'postgres://user:secret@db.invalid/app',
  ])('omits credential-bearing diagnostic text', (input) => {
    expect(sanitizeInitialDiagnostic(complete(input))).toBe(INITIAL_DIAGNOSTIC_OMITTED);
  });

  it.each([
    'NPM_TOKEN=credential-sentinel',
    'DATABASE_PASSWORD: credential-sentinel',
    'clientSecret=credential-sentinel',
    'npm_config_authToken=credential-sentinel',
    'PGPASSWORD=credential-sentinel',
    '_authToken=abc123',
    '_authToken: abc123',
    '"_authToken": "abc123"',
    '"clientSecret": "credential-sentinel"',
    "'NPM_TOKEN': 'credential-sentinel'",
    'clientSecret=credential-sentinel\ncontinued credential-sentinel',
    'config:NPM_TOKEN=abc123',
    'config:clientSecret=abc123',
    'config: _authToken=abc123',
    'config=npm_config_authToken=abc123',
    'config:{"DATABASE_PASSWORD":"abc123"}',
    'first:config:NPM_TOKEN=abc123',
    'safe=1;config:NPM_TOKEN=abc123',
  ])('omits supported compound credential assignment %s', (input) => {
    const sanitized = sanitizeInitialDiagnostic(complete(input));
    expect(sanitized).toBe(INITIAL_DIAGNOSTIC_OMITTED);
    expect(sanitizeInitialDiagnostic(complete(sanitized))).toBe(sanitized);
  });

  it.each([
    'tokenCount=7',
    'passwordPolicy=strict',
    'secretariat=meeting-room',
    'token_count=3',
    'config:tokenCount=7',
    'config:passwordPolicy=strict',
    'config:secretariat=room',
    'config:token_count=3',
    'config:_authTokenCount=7',
    'config:host=localhost',
    'config:port=33211',
    '{"config":{"tokenCount":7,"passwordPolicy":"strict"}}',
    'NPM_TOKEN is not configured',
    'the service reports tokens during startup',
  ])('preserves non-credential text that merely resembles a credential key: %s', (input) => {
    expect(sanitizeInitialDiagnostic(complete(input))).toBe(input);
  });

  it('scans assignments independently across positive and negative inputs', () => {
    expect(sanitizeInitialDiagnostic(complete('config:NPM_TOKEN=abc123'))).toBe(
      INITIAL_DIAGNOSTIC_OMITTED,
    );
    expect(sanitizeInitialDiagnostic(complete('config:tokenCount=7'))).toBe('config:tokenCount=7');
    expect(sanitizeInitialDiagnostic(complete('_authToken=abc123'))).toBe(
      INITIAL_DIAGNOSTIC_OMITTED,
    );
  });

  it.each(['\t', '\0', '\u001b[31m', '\u00a0', '\u2028', '\u202e', '\u0085', '\r'])(
    'omits control or ambiguous whitespace U+%s',
    (character) => {
      expect(sanitizeInitialDiagnostic(complete(`password${character}=secret`))).toBe(
        INITIAL_DIAGNOSTIC_OMITTED,
      );
    },
  );

  it.each(['\u2061', '\u2062', '\u200c', '\u200d', '\u202e', '\ufeff'])(
    'omits credentials split by Unicode format control %s',
    (character) => {
      expect(sanitizeInitialDiagnostic(complete(`pass${character}word=hidden-secret`))).toBe(
        INITIAL_DIAGNOSTIC_OMITTED,
      );
    },
  );

  it('preserves ordinary safe failure text and normalizes CRLF', () => {
    expect(sanitizeInitialDiagnostic(complete('application-bootstrap failed: ECONNREFUSED'))).toBe(
      'application-bootstrap failed: ECONNREFUSED',
    );
    expect(sanitizeInitialDiagnostic(complete('first line\r\nsecond line'))).toBe(
      'first line\nsecond line',
    );
    expect(sanitizeInitialDiagnostic(complete('正常な診断テキスト'))).toBe('正常な診断テキスト');
    expect(sanitizeInitialDiagnostic(complete('failed https://example.invalid/path'))).toBe(
      'failed URL origin scheme=https host=example.invalid port=443',
    );
    expect(sanitizeInitialDiagnostic(complete('https://example.invalid/path   '))).toBe(
      'URL origin scheme=https host=example.invalid port=443',
    );
    expect(sanitizeInitialDiagnostic(complete('https://bad/path'))).toBe(
      'URL origin scheme=https host=bad port=443',
    );
    expect(sanitizeInitialDiagnostic(complete('password=\r\nsecret'))).toBe(
      INITIAL_DIAGNOSTIC_OMITTED,
    );
    expect(sanitizeInitialDiagnostic(complete('https://example.invalid/\r\nsecret'))).toBe(
      INITIAL_DIAGNOSTIC_OMITTED,
    );
  });

  it('fails closed for incomplete capture and oversized input/output', () => {
    expect(sanitizeInitialDiagnostic({ status: 'incomplete' })).toBe(INITIAL_DIAGNOSTIC_OMITTED);
    expect(sanitizeInitialDiagnostic(complete('x'.repeat(16 * 1024 + 1)))).toBe(
      INITIAL_DIAGNOSTIC_OMITTED,
    );
    expect(sanitizeInitialDiagnostic(complete('é'.repeat(2049)))).toBe(INITIAL_DIAGNOSTIC_OMITTED);
  });

  it('redacts fixture roots and is idempotent', () => {
    const once = sanitizeInitialDiagnostic(complete('failed in /tmp/private-root: ECONNREFUSED'), [
      '/tmp/private-root',
    ]);
    expect(once).toBe('failed in <fixture>: ECONNREFUSED');
    expect(sanitizeInitialDiagnostic(complete(once))).toBe(once);
    expect(sanitizeInitialDiagnostic(complete(INITIAL_DIAGNOSTIC_OMITTED))).toBe(
      INITIAL_DIAGNOSTIC_OMITTED,
    );
  });

  it('falls back to fixed markers when JSON escaping would exceed the receipt cap', () => {
    const receipt = serializeInitialInstallFailureReceipt({
      testCase: 'real-stable-activation-mode',
      platform: 'linux',
      arch: 'x64',
      finishCode: 17,
      signal: null,
      stdoutDiagnostic: { status: 'complete', text: '\n'.repeat(4096) },
      stderrDiagnostic: { status: 'complete', text: '\n'.repeat(4096) },
      diagnostics: diagnostics('\n'.repeat(4096)),
    });
    expect(Buffer.byteLength(`${receipt}\n`, 'utf8')).toBeLessThanOrEqual(24 * 1024);
    expect(JSON.parse(receipt.slice('REVO_INITIAL_INSTALL_FAILURE '.length))).toMatchObject({
      stdoutDiagnostic: INITIAL_DIAGNOSTIC_OMITTED,
      stderrDiagnostic: INITIAL_DIAGNOSTIC_OMITTED,
      diagnostics: {
        logs: {
          'install-session.log': { diagnostic: INITIAL_DIAGNOSTIC_OMITTED },
          'server-start.log': { diagnostic: INITIAL_DIAGNOSTIC_OMITTED },
          'activation-result.log': { diagnostic: INITIAL_DIAGNOSTIC_OMITTED },
        },
      },
    });
  });

  it('does not leak credentials from a malformed URL prefix into the receipt', () => {
    const safeDiagnostics = diagnostics('safe');
    const receipt = serializeInitialInstallFailureReceipt({
      testCase: 'real-stable-activation-mode',
      platform: 'linux',
      arch: 'x64',
      finishCode: 1,
      signal: null,
      stdoutDiagnostic: { status: 'incomplete' },
      stderrDiagnostic: { status: 'incomplete' },
      diagnostics: {
        ...safeDiagnostics,
        logs: {
          ...safeDiagnostics.logs,
          'install-session.log': {
            status: 'captured',
            sizeBytes: 44,
            diagnostic: 'https://\nalice:s3cr3t@example.invalid/path',
          },
        },
      },
    });
    expect(receipt).not.toContain('s3cr3t');
    expect(receipt).toContain(INITIAL_DIAGNOSTIC_OMITTED);
  });

  it('bounds metadata, rejects invalid identity and exit fields, and drops unknown keys', () => {
    const base = {
      testCase: 'real-stable-activation-mode',
      platform: 'linux',
      arch: 'x64',
      finishCode: 1,
      signal: `SIG${'A'.repeat(30_000)}`,
      stdoutDiagnostic: { status: 'incomplete' } as const,
      stderrDiagnostic: { status: 'incomplete' } as const,
      diagnostics: {
        ...diagnostics('safe-diagnostic'),
        untrusted: 'must-not-be-serialized',
        logs: {
          ...diagnostics('safe-diagnostic').logs,
          'install-session.log': {
            status: 'captured',
            sizeBytes: -1,
            diagnostic: 'unsafe-size-sentinel',
          },
        },
      },
    };
    const receipt = serializeInitialInstallFailureReceipt(base);

    expect(Buffer.byteLength(`${receipt}\n`, 'utf8')).toBeLessThanOrEqual(24 * 1024);
    expect(receipt).not.toContain('must-not-be-serialized');
    expect(receipt).not.toContain('unsafe-size-sentinel');
    expect(receipt).not.toContain('A'.repeat(100));
    expect(JSON.parse(receipt.slice('REVO_INITIAL_INSTALL_FAILURE '.length))).toMatchObject({
      signal: null,
      diagnostics: {
        logs: {
          'install-session.log': {
            status: 'incomplete',
            sizeBytes: null,
            diagnostic: INITIAL_DIAGNOSTIC_OMITTED,
          },
        },
      },
    });

    expect(() =>
      serializeInitialInstallFailureReceipt({ ...base, testCase: 'unknown-test-case' }),
    ).toThrow('invalid initial-install test case');
    expect(() => serializeInitialInstallFailureReceipt({ ...base, platform: 'windows' })).toThrow(
      'invalid initial-install platform',
    );
    expect(() => serializeInitialInstallFailureReceipt({ ...base, arch: 'ia32' })).toThrow(
      'invalid initial-install architecture',
    );
    expect(() =>
      serializeInitialInstallFailureReceipt({ ...base, finishCode: Number.NaN }),
    ).toThrow('invalid initial-install finish code');
    expect(() => serializeInitialInstallFailureReceipt({ ...base, finishCode: 256 })).toThrow(
      'invalid initial-install finish code',
    );
  });

  it('never serializes text from a non-captured log status', () => {
    const receipt = serializeInitialInstallFailureReceipt({
      testCase: 'real-stable-activation-mode',
      platform: 'linux',
      arch: 'x64',
      finishCode: 1,
      signal: null,
      stdoutDiagnostic: { status: 'incomplete' },
      stderrDiagnostic: { status: 'incomplete' },
      diagnostics: {
        status: 'complete',
        reason: 'none',
        logs: {
          'install-session.log': {
            status: 'unsafe',
            sizeBytes: null,
            diagnostic: 'unsafe-secret-sentinel',
          },
          'server-start.log': {
            status: 'captured',
            sizeBytes: 4,
            diagnostic: 'safe',
          },
          'activation-result.log': {
            status: 'io-error',
            sizeBytes: null,
            diagnostic: 'io-error-secret-sentinel',
          },
        },
      },
    });
    const parsed = JSON.parse(receipt.slice('REVO_INITIAL_INSTALL_FAILURE '.length));

    expect(parsed.diagnostics.status).toBe('incomplete');
    expect(parsed.diagnostics.logs['install-session.log'].diagnostic).toBe(
      INITIAL_DIAGNOSTIC_OMITTED,
    );
    expect(parsed.diagnostics.logs['server-start.log'].diagnostic).toBe('safe');
    expect(parsed.diagnostics.logs['activation-result.log'].diagnostic).toBe(
      INITIAL_DIAGNOSTIC_OMITTED,
    );
    expect(receipt).not.toContain('unsafe-secret-sentinel');
    expect(receipt).not.toContain('io-error-secret-sentinel');
  });

  it('preserves valid too-large byte counts and downgrades aggregate status for malformed records', () => {
    const base = diagnostics('safe-neighbor');
    const receipt = serializeInitialInstallFailureReceipt({
      testCase: 'real-stable-activation-mode',
      platform: 'linux',
      arch: 'x64',
      finishCode: 1,
      signal: null,
      stdoutDiagnostic: { status: 'incomplete' },
      stderrDiagnostic: { status: 'incomplete' },
      diagnostics: {
        ...base,
        logs: {
          ...base.logs,
          'install-session.log': {
            status: 'too-large',
            sizeBytes: 16 * 1024 + 1,
            diagnostic: 'must-not-be-published',
          },
          'server-start.log': {
            status: 'captured',
            sizeBytes: 16 * 1024 + 1,
            diagnostic: 'malformed-record-sentinel',
          },
        },
      },
    });
    const parsed = JSON.parse(receipt.slice('REVO_INITIAL_INSTALL_FAILURE '.length));

    expect(parsed.diagnostics.status).toBe('incomplete');
    expect(parsed.diagnostics.logs['install-session.log']).toMatchObject({
      status: 'too-large',
      sizeBytes: 16 * 1024 + 1,
      diagnostic: INITIAL_DIAGNOSTIC_OMITTED,
    });
    expect(parsed.diagnostics.logs['server-start.log']).toMatchObject({
      status: 'incomplete',
      sizeBytes: null,
      diagnostic: INITIAL_DIAGNOSTIC_OMITTED,
    });
    expect(parsed.diagnostics.logs['activation-result.log'].diagnostic).toBe('safe-neighbor');
    expect(receipt).not.toContain('must-not-be-published');
    expect(receipt).not.toContain('malformed-record-sentinel');
  });
});
