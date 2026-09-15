import type {
  ServerLifecycleCode,
  ServerLifecycleCorePhase,
  ServerLifecycleSink,
} from '../../../src/server-logs/server-lifecycle.types.js';

export class ServerLifecycleProbe implements ServerLifecycleSink {
  readonly codes: ServerLifecycleCode[] = [];
  readonly entered: Promise<void>;
  private notifyEntered!: () => void;
  private releaseGate: (() => void) | undefined;
  private blockedCode: ServerLifecycleCode | undefined;
  private onEnter: (() => void) | undefined;
  private gate: Promise<void> | undefined;
  private readonly waiters = new Map<ServerLifecycleCode, (() => void)[]>();
  rejections = 0;

  constructor(private readonly rejectWrites = false) {
    this.entered = new Promise((resolve) => (this.notifyEntered = resolve));
  }

  block(code: ServerLifecycleCode, onEnter?: () => void) {
    this.blockedCode = code;
    this.onEnter = onEnter;
    this.gate = new Promise((resolve) => (this.releaseGate = resolve));
  }

  release() {
    this.releaseGate?.();
  }

  waitFor(code: ServerLifecycleCode): Promise<void> {
    if (this.codes.includes(code)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiters = this.waiters.get(code) ?? [];
      waiters.push(resolve);
      this.waiters.set(code, waiters);
    });
  }

  emit(code: ServerLifecycleCode, _corePhase?: ServerLifecycleCorePhase): Promise<void> {
    this.codes.push(code);
    this.waiters
      .get(code)
      ?.splice(0)
      .forEach((resolve) => resolve());
    if (this.rejectWrites) {
      this.rejections += 1;
      return Promise.reject(new Error('lifecycle fixture rejection'));
    }
    if (code === this.blockedCode) {
      this.notifyEntered();
      this.onEnter?.();
      return this.gate ?? Promise.resolve();
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    return this.gate ?? Promise.resolve();
  }
}
