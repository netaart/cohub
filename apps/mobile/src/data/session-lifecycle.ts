type SessionLifecycleOptions = {
  load: (sessionId: string) => Promise<void>;
  release: (sessionId: string) => void;
  releaseDelayMs: number;
};

/** Keep one load/subscription across a brief navigation round trip, not an indefinite background stream. */
export function createSessionLifecycle(options: SessionLifecycleOptions) {
  const sessions = new Map<string, {
    readers: number;
    task: Promise<void>;
    timer: ReturnType<typeof setTimeout> | null;
  }>();

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
    close(sessionId: string): void {
      const entry = sessions.get(sessionId);
      if (!entry || entry.readers === 0) return;
      entry.readers -= 1;
      if (entry.readers > 0) return;
      entry.timer = setTimeout(() => {
        sessions.delete(sessionId);
        options.release(sessionId);
      }, options.releaseDelayMs);
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
