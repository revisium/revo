import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

type Behavior = 'serve' | 'stall' | 'corrupt' | 'missing';

export interface FixtureCertificate {
  readonly certPath: string;
  readonly cert: Buffer;
  readonly key: Buffer;
}

export interface StalledDownload {
  readonly requested: Promise<void>;
}

const OPENSSL_CONFIG = `[req]
distinguished_name = subject
x509_extensions = loopback
prompt = no
[subject]
CN = 127.0.0.1
[loopback]
subjectAltName = IP:127.0.0.1
basicConstraints = critical,CA:TRUE
`;

export async function createFixtureCertificate(directory: string): Promise<FixtureCertificate> {
  const configPath = join(directory, 'openssl.cnf');
  const certPath = join(directory, 'origin.pem');
  const keyPath = join(directory, 'origin.key');
  await writeFile(configPath, OPENSSL_CONFIG);
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-config',
    configPath,
    '-keyout',
    keyPath,
    '-out',
    certPath,
  ]);
  return { certPath, cert: await readFile(certPath), key: await readFile(keyPath) };
}

export class FixtureOrigin {
  private readonly files = new Map<string, Buffer>();
  private readonly behaviors = new Map<string, Behavior>();
  private readonly stalls = new Map<string, () => void>();
  private readonly requestLog: string[] = [];

  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(certificate: FixtureCertificate): Promise<FixtureOrigin> {
    const server = createServer({ cert: certificate.cert, key: certificate.key });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('fixture origin has no TCP address');
    }
    const origin = new FixtureOrigin(server, `https://127.0.0.1:${String(address.port)}`);
    server.on('request', (request, response) => origin.respond(request.url ?? '', response));
    return origin;
  }

  publish(path: string, bytes: Buffer): string {
    this.files.set(path, bytes);
    return `${this.url}${path}`;
  }

  stall(path: string): StalledDownload {
    this.behaviors.set(path, 'stall');
    return {
      requested: new Promise<void>((resolve) => this.stalls.set(path, resolve)),
    };
  }

  corrupt(path: string): void {
    this.behaviors.set(path, 'corrupt');
  }

  remove(path: string): void {
    this.behaviors.set(path, 'missing');
  }

  restore(path: string): void {
    this.behaviors.delete(path);
  }

  requests(): readonly string[] {
    return [...this.requestLog];
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private respond(path: string, response: ServerResponse): void {
    this.requestLog.push(path);
    const bytes = this.files.get(path);
    const behavior = this.behaviors.get(path) ?? 'serve';
    if (bytes === undefined || behavior === 'missing') {
      response.writeHead(404).end();
      return;
    }
    if (behavior === 'corrupt') {
      response.writeHead(200, { 'content-length': bytes.length }).end(Buffer.alloc(bytes.length));
      return;
    }
    if (behavior === 'stall') {
      response.writeHead(200, { 'content-length': bytes.length });
      response.write(bytes.subarray(0, Math.floor(bytes.length / 2)), () => {
        this.stalls.get(path)?.();
      });
      return;
    }
    response.writeHead(200, { 'content-length': bytes.length }).end(bytes);
  }
}
