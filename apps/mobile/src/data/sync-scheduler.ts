export type SyncTask = {
  run: () => Promise<void>;
  intervalMs: () => number;
  minRefreshMs?: number;
};

type Entry = {
  readers: Set<SyncTask>;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  dirty: boolean;
  lastSuccessAt: number | null;
  lastStartedAt: number | null;
  dueAt: number | null;
  failures: number;
  blocked: boolean;
};

/** Account-owned scheduling. Readers share work, while data owners reconcile its results. */
export function createSyncScheduler(options: { active?: boolean; random?: () => number } = {}) {
  const entries = new Map<string, Entry>();
  const ready = new Set<string>();
  const random = options.random ?? Math.random;
  let active = options.active ?? false;
  let disposed = false;
  let running = 0;

  const interval = (entry: Entry) => Math.min(...[...entry.readers].map((reader) => reader.intervalMs()));
  const clearTimer = (entry: Entry) => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    entry.dueAt = null;
  };
  const schedule = (key: string, entry: Entry, delay: number) => {
    if (!active || disposed || entry.readers.size === 0 || entry.blocked) return;
    const minimum = Math.max(...[...entry.readers].map((reader) => reader.minRefreshMs ?? 0));
    const dueAt = Math.max(Date.now() + delay, entry.lastStartedAt === null ? 0 : entry.lastStartedAt + minimum);
    // Continuous invalidations must not postpone a refresh indefinitely.
    if (entry.dueAt !== null && entry.dueAt <= dueAt) return;
    clearTimer(entry);
    entry.dueAt = dueAt;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.dueAt = null;
      ready.add(key);
      pump();
    }, Math.max(0, dueAt - Date.now()));
  };
  const pump = () => {
    if (!active || disposed) return;
    for (const key of ready) {
      if (running >= 4) break;
      const entry = entries.get(key);
      ready.delete(key);
      if (!entry || entry.running || entry.readers.size === 0) continue;
      entry.running = true;
      entry.dirty = false;
      running += 1;
      void Promise.resolve().then(async () => {
        const task = [...entry.readers].at(-1);
        if (!active || disposed || !task) return;
        entry.lastStartedAt = Date.now();
        await task.run();
        entry.lastSuccessAt = Date.now();
        entry.failures = 0;
        entry.blocked = false;
      }).catch((error: unknown) => {
        entry.failures += 1;
        const cause = error instanceof Error && error.cause ? error.cause : error;
        const status = typeof cause === "object" && cause !== null && "status" in cause ? cause.status : null;
        entry.blocked = status === 401 || status === 403;
      }).finally(() => {
        entry.running = false;
        running -= 1;
        if (entry.readers.size === 0) entries.delete(key);
        else if (entry.dirty) schedule(key, entry, 250);
        else {
          const delay = Math.min(120_000, interval(entry) * 2 ** Math.min(entry.failures, 6));
          schedule(key, entry, delay * (0.9 + random() * 0.2));
        }
        pump();
      });
    }
  };

  return {
    watch(key: string, task: SyncTask): () => void {
      if (disposed) return () => undefined;
      const entry = entries.get(key) ?? { readers: new Set<SyncTask>(), timer: null, running: false, dirty: false, lastSuccessAt: null, lastStartedAt: null, dueAt: null, failures: 0, blocked: false };
      entries.set(key, entry);
      entry.readers.add(task);
      if (!entry.running) {
        const age = entry.lastSuccessAt === null ? Infinity : Date.now() - entry.lastSuccessAt;
        schedule(key, entry, Math.max(250, interval(entry) - age));
      }
      return () => {
        entry.readers.delete(task);
        if (entry.readers.size > 0) return;
        clearTimer(entry);
        ready.delete(key);
        if (!entry.running) entries.delete(key);
      };
    },
    invalidate(key?: string): void {
      for (const [id, entry] of entries) {
        if (key !== undefined && id !== key) continue;
        entry.blocked = false;
        if (entry.running) entry.dirty = true;
        else schedule(id, entry, 250);
      }
    },
    invalidatePrefix(prefix: string): void {
      for (const key of entries.keys()) if (key.startsWith(prefix)) this.invalidate(key);
    },
    setActive(next: boolean): void {
      if (active === next || disposed) return;
      active = next;
      if (next) this.invalidate();
      else {
        ready.clear();
        for (const entry of entries.values()) clearTimer(entry);
      }
    },
    dispose(): void {
      disposed = true;
      ready.clear();
      for (const entry of entries.values()) clearTimer(entry);
      entries.clear();
    },
  };
}

export type SyncScheduler = ReturnType<typeof createSyncScheduler>;
