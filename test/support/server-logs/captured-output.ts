import { vi } from 'vitest';

/** Captures everything a process would append to its server log through stdout and stderr. */
export class CapturedOutput {
  private readonly chunks: string[] = [];
  private readonly spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => this.record(chunk)),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => this.record(chunk)),
  ];

  text(): string {
    return this.chunks.join('');
  }

  restore(): void {
    for (const spy of this.spies) {
      spy.mockRestore();
    }
  }

  private record(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }
}
