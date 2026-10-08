export function createSessionSnapshotScheduler(
  refresh: (sessionId: string, fromSequence?: number) => Promise<unknown>,
  onError: (error: unknown, sessionId: string) => void,
  delayMs = 25,
): ((sessionId: string, fromSequence?: number) => Promise<void>) & { flush: () => Promise<void> } {
  const pending = new Map<string, { dirty: boolean; fromSequence: number | undefined; promise: Promise<void> }>();
  let active = 0;
  const waiters: Array<() => void> = [];
  const withSlot = async (task: () => Promise<void>) => {
    if (active >= 2) await new Promise<void>((resolve) => { waiters.push(resolve); });
    else active++;
    try { await task(); }
    finally {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
  };
  const schedule = (sessionId: string, fromSequence?: number) => {
    const existing = pending.get(sessionId);
    if (existing) {
      existing.dirty = true;
      existing.fromSequence = existing.fromSequence == null ? fromSequence : fromSequence == null ? existing.fromSequence : Math.min(existing.fromSequence, fromSequence);
      return existing.promise;
    }
    const state = { dirty: false, fromSequence, promise: Promise.resolve() };
    state.promise = Promise.resolve().then(async () => {
      try {
        do {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          await withSlot(async () => {
            state.dirty = false;
            try { await refresh(sessionId, state.fromSequence); }
            catch (error) {
              try { onError(error, sessionId); }
              catch { /* Best effort. */ }
            }
          });
        } while (state.dirty);
      } finally {
        pending.delete(sessionId);
      }
    });
    pending.set(sessionId, state);
    return state.promise;
  };
  return Object.assign(schedule, { flush: async () => { await Promise.all([...pending.values()].map((state) => state.promise)); } });
}
