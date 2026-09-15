export interface FollowOptions<T extends { readonly cursor: number }> {
  readonly read: (afterSequence: number) => Promise<T>;
  readonly wait: (signal: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
  readonly onSnapshot: (snapshot: T) => void | Promise<void>;
}

export async function follow<T extends { readonly cursor: number }>(
  options: FollowOptions<T>,
): Promise<void> {
  let cursor = 0;
  while (!options.signal.aborted) {
    // oxlint-disable-next-line no-await-in-loop -- follow reads are ordered
    const snapshot = await options.read(cursor);
    // oxlint-disable-next-line no-await-in-loop -- snapshots are delivered in order
    await options.onSnapshot(snapshot);
    cursor = snapshot.cursor;
    // oxlint-disable-next-line no-await-in-loop -- wait between ordered reads
    await options.wait(options.signal);
  }
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
