type SessionLifecycleOptions = {
  load: (sessionId: string) => Promise<void>;
  release: (sessionId: string) => void;
  releaseDelayMs: number;
};

type SessionEntry = {
  readers: number;
  task: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
};

/** Keep one load/subscription across a brief navigation round trip, not an indefinite background stream. */
export function createSessionLifecycle(options: SessionLifecycleOptions) {
  const sessions = new Map<string, SessionEntry>();

  const scheduleRelease = (sessionId: string, entry: SessionEntry) => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const current = sessions.get(sessionId);
      if (!current || current.readers > 0) return;
      sessions.delete(sessionId);
      options.release(sessionId);
    }, options.releaseDelayMs);
  };

  return {
    open(sessionId: string): Promise<void> {
      const existing = sessions.get(sessionId);
      if (existing) {
        if (existing.timer !== null) clearTimeout(existing.timer);
        existing.timer = null;
        existing.readers += 1;
        return existing.task;
      }
      const task = options.load(sessionId);
      sessions.set(sessionId, { readers: 1, task, timer: null });
      return task;
    },
    /** Start the load on press-in without taking a reader; `open` reuses the in-flight task. */
    prime(sessionId: string): void {
      if (sessions.has(sessionId)) return;
      const entry: SessionEntry = { readers: 0, task: options.load(sessionId), timer: null };
      sessions.set(sessionId, entry);
      scheduleRelease(sessionId, entry);
    },
    close(sessionId: string): void {
      const entry = sessions.get(sessionId);
      if (!entry || entry.readers === 0) return;
      entry.readers -= 1;
      if (entry.readers > 0) return;
      scheduleRelease(sessionId, entry);
    },
    clear(): void {
      for (const [sessionId, entry] of sessions) {
        if (entry.timer !== null) clearTimeout(entry.timer);
        options.release(sessionId);
      }
      sessions.clear();
    },
  };
}
