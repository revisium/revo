interface FollowOptions<T extends { readonly cursor: number }> {
  readonly read: (afterSequence: number) => Promise<T>;
  readonly wait: (signal: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
  readonly onSnapshot: (snapshot: T) => void | Promise<void>;
}

export function follow<T extends { readonly cursor: number }>(
  options: FollowOptions<T>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cycle = async (cursor: number): Promise<void> => {
      if (options.signal.aborted) {
        resolve();
        return;
      }
      try {
        const snapshot = await options.read(cursor);
        await options.onSnapshot(snapshot);
        await options.wait(options.signal);
        void cycle(snapshot.cursor);
      } catch (error) {
        reject(error);
      }
    };
    void cycle(0);
  });
}

export function waitForFollowPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, 500);
    signal.addEventListener('abort', done, { once: true });

    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
