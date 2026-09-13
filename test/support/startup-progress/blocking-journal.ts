import { StartupProgressJournalWriter } from '../../../src/startup-progress/startup-progress-journal.service.js';

export class BlockingJournal extends StartupProgressJournalWriter {
  private mode: 'next' | 'postgres-completion' | undefined;
  private released = false;
  private releaseWrite: (() => void) | undefined;
  private notifyEntered: (() => void) | undefined;
  entered: Promise<void> = Promise.resolve();
  private gate: Promise<void> = Promise.resolve();

  blockNext() {
    this.arm('next');
  }

  blockPostgresCompletion() {
    this.arm('postgres-completion');
  }

  release() {
    if (!this.released) {
      this.released = true;
      this.releaseWrite?.();
    }
  }

  override async write(...parameters: Parameters<StartupProgressJournalWriter['write']>) {
    const event = parameters[2].at(-1);
    const matches =
      this.mode === 'next' ||
      (this.mode === 'postgres-completion' &&
        event?.phase === 'postgres-start' &&
        event.status === 'completed');
    if (matches) {
      this.mode = undefined;
      this.notifyEntered?.();
      await this.gate;
    }
    return super.write(...parameters);
  }

  private arm(mode: 'next' | 'postgres-completion') {
    this.mode = mode;
    this.released = false;
    this.entered = new Promise((resolve) => {
      this.notifyEntered = resolve;
    });
    this.gate = new Promise((resolve) => {
      this.releaseWrite = resolve;
    });
  }
}
