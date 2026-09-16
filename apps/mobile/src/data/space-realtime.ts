import type { SpaceRealtimeEvent } from "./space-realtime-events";

/** Focused readers share SDK rooms. No second transport or per-token state processing. */
export function createSpaceRealtime(options: {
  subscribe: (spaceId: string, listener: (event: SpaceRealtimeEvent) => void) => () => void;
  event: (event: SpaceRealtimeEvent) => void;
  error: (message: string | null) => void;
}) {
  const readers = new Set<readonly string[]>();
  const rooms = new Map<string, () => void>();
  let active = false;
  let disposed = false;
  const reconcile = () => {
    const wanted = new Set(active && !disposed ? [...new Set([...readers].flatMap((ids) => [...ids]))].slice(0, 10) : []);
    for (const [id, stop] of rooms) {
      if (wanted.has(id)) continue;
      rooms.delete(id);
      stop();
    }
    for (const id of wanted) {
      if (rooms.has(id)) continue;
      let alive = true;
      const stop = options.subscribe(id, (event) => {
        if (!alive || !active || disposed) return;
        if (event.type === "system.subscribe.error") {
          const rejected = (event.payload as { rejected?: { room: string }[] }).rejected ?? [];
          if (rejected.some((item: { room: string }) => item.room === `space:${id}`)) options.error("Realtime Space access was rejected. Check your access and reopen the Space.");
          return;
        }
        if (event.spaceId !== id) return;
        options.event(event);
      });
      rooms.set(id, () => { alive = false; stop(); });
    }
  };
  return {
    watch(spaceIds: readonly string[]): () => void {
      if (disposed) return () => undefined;
      const ids = [...new Set(spaceIds)];
      if (ids.some((id) => !id.trim())) throw new Error("A realtime Space requires a non-empty ID.");
      readers.add(ids);
      reconcile();
      return () => { readers.delete(ids); reconcile(); };
    },
    setActive(next: boolean): void {
      if (active === next || disposed) return;
      active = next;
      if (next) options.error(null);
      reconcile();
    },
    dispose(): void {
      disposed = true;
      readers.clear();
      reconcile();
    },
  };
}

export type SpaceRealtime = ReturnType<typeof createSpaceRealtime>;
