import type { Readable, Writable } from 'node:stream';

import type { ManagedProcessError } from './managed-process-error.js';

export type ProcessStdio = 'ignore' | 'inherit' | 'pipe' | number;
export type ProcessMessage = bigint | boolean | number | object | string;

export interface ManagedProcessRequest {
  readonly args: readonly string[];
  readonly cancellation?: Readonly<{
    readonly graceMs: number;
    readonly killWaitMs: number;
    readonly signal: AbortSignal;
  }>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly ipc?: boolean;
  readonly stdio: Readonly<{
    stderr: ProcessStdio;
    stdin: ProcessStdio;
    stdout: ProcessStdio;
  }>;
}

export interface ProcessCompletion {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface StopProcessRequest {
  readonly graceMs: number;
  readonly killWaitMs: number;
}

export type ProcessCancellationResult =
  | { readonly kind: 'failed'; readonly error: ManagedProcessError }
  | { readonly kind: 'not-requested' }
  | { readonly kind: 'stopped' };

export interface OwnedProcess {
  readonly cancellationResult?: Promise<ProcessCancellationResult>;
  readonly completion: Promise<ProcessCompletion>;
  readonly stderr?: Readable;
  readonly stdin?: Writable;
  readonly stdout?: Readable;
  send?(message: ProcessMessage): Promise<void>;
  subscribe?(listener: (message: unknown) => void): () => void;
}
