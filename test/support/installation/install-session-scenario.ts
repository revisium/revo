import { vi } from 'vitest';

import type { runPackageProcess } from '../../../src/installation/package-process.js';
import type { PnpmProgressSink } from '../../../src/installation/pnpm-progress.js';
import { ProgressOperation, type ProgressEvent } from '../../../src/progress/index.js';

type Request = Parameters<typeof runPackageProcess>[0];
interface StartInput {
  readonly activation: { readonly status: string; readonly generationId: string };
  readonly packageResult: {
    readonly directory: string;
    readonly plan: { readonly release: { readonly channel: string } };
  };
  readonly nodeExecutable: string;
  readonly channelRoot: string;
  readonly scratch: string;
  readonly signal?: AbortSignal;
}
interface Session {
  stdout(text: string): void;
  stage(value: string): void;
  readonly packageProgress: PnpmProgressSink;
  start(input: StartInput): Promise<ProgressEvent>;
  finish(): Promise<void>;
  fail(scratch: string | undefined, error?: Error): Promise<void>;
}
interface Options {
  readonly transcript?: string;
  readonly exitCode?: number;
  readonly outputFailure?: boolean;
  readonly stdoutFailure?: boolean;
  readonly stdoutSink?: unknown;
  readonly outputTimeoutMs?: number;
}
const api = await vi.importActual<{
  InstallSession: new (options: {
    stdout: unknown;
    stderr: (text: string) => void;
    isTty: boolean;
    run: typeof runPackageProcess;
    outputTimeoutMs?: number;
  }) => Session;
}>(new URL('../../../installer/install-session.mjs', import.meta.url).href);

export class InstallSessionScenario {
  readonly requests: Request[] = [];
  readonly output: string[] = [];
  readonly errors: string[] = [];
  readonly root = "/private/install 'quoted/stable";
  beforeExit = '';
  readonly session: Session;

  constructor({
    transcript = startupTranscript(),
    exitCode = 0,
    outputFailure = false,
    stdoutFailure = false,
    stdoutSink,
    outputTimeoutMs,
  }: Options = {}) {
    this.session = new api.InstallSession({
      stdout:
        stdoutSink ??
        ((text: string) => {
          if (stdoutFailure) {
            throw new Error('private stdout pipe error');
          }
          this.output.push(text);
        }),
      ...(outputTimeoutMs === undefined ? {} : { outputTimeoutMs }),
      stderr: (text) => {
        if (outputFailure) {
          throw new Error('private pipe error');
        }
        this.errors.push(text);
      },
      isTty: false,
      run: async (request) => {
        this.requests.push(request);
        const bytes = Buffer.from(transcript);
        for (let offset = 0; offset < bytes.length; offset += 7) {
          request.onStdout?.(bytes.subarray(offset, offset + 7));
        }
        this.beforeExit = this.output.join('');
        return {
          exitCode,
          signal: null,
          stdout: transcript,
          stderr: '',
          diagnosticPath: request.diagnosticPath,
        };
      },
    });
  }

  start(status = 'activated', signal?: AbortSignal) {
    return this.session.start({
      activation: { status, generationId: 'a'.repeat(64) },
      packageResult: { directory: '/private/package', plan: { release: { channel: 'stable' } } },
      nodeExecutable: '/private/node/bin/node',
      channelRoot: this.root,
      scratch: '/private/attempt/scratch',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  text() {
    return this.output.join('');
  }

  writeStdout(text: string) {
    this.session.stdout(text);
  }
}

export function startupTranscript(reused = false): string {
  const operation = new ProgressOperation({ operationId: '1'.repeat(32), now: () => 0 });
  const events = [
    operation.start('server-start'),
    operation.ready({ url: 'http://127.0.0.1:3210', ...(reused ? { reused: true } : {}) }),
  ];
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}

export function foreignStartupTranscript(): string {
  const [started = '', ready = ''] = startupTranscript().split('\n');
  return `${started}\n${ready.replace('1'.repeat(32), '2'.repeat(32))}\n`;
}
