import type { CohubClient } from "@neta-art/cohub";
import { useEffect, useState } from "react";

/** Page size shared by the Space page preview and the list count probe. */
export const SPACE_SESSION_COUNT_PAGE_SIZE = 20;
const COUNT_TTL_MS = 5 * 60_000;
const COUNT_CONCURRENCY = 4;

export type SpaceSessionCount = {
  count: number;
  hasMore: boolean;
};

export type SpaceSessionCounts = Record<string, SpaceSessionCount>;

type CountEntry = SpaceSessionCount & { checkedAt: number };

type CountStore = {
  entries: Map<string, CountEntry>;
  pending: Map<string, Promise<void>>;
};

// Per-client so a signed-out account's counts never leak into the next session.
const stores = new WeakMap<CohubClient, CountStore>();

function countStore(client: CohubClient) {
  const existing = stores.get(client);
  if (existing) return existing;
  const created: CountStore = { entries: new Map(), pending: new Map() };
  stores.set(client, created);
  return created;
}

export function getSpaceSessionCount(client: CohubClient | null, spaceId: string): SpaceSessionCount | null {
  if (!client) return null;
  const entry = countStore(client).entries.get(spaceId);
  return entry ? { count: entry.count, hasMore: entry.hasMore } : null;
}

export function publishSpaceSessionCount(client: CohubClient, spaceId: string, count: number, hasMore: boolean) {
  countStore(client).entries.set(spaceId, { count, hasMore, checkedAt: Date.now() });
}

/**
 * Probe each Space's first Chat page to learn its size. The API exposes no
 * count, so `hasMore` becomes a "+" in the UI; entries are cached briefly and
 * in-flight probes are shared between screens.
 */
export async function loadSpaceSessionCounts(client: CohubClient, spaceIds: readonly string[], options: { force?: boolean } = {}) {
  const store = countStore(client);
  const now = Date.now();
  const targets = [...new Set(spaceIds)].filter((spaceId) => {
    if (!spaceId) return false;
    if (options.force) return true;
    const entry = store.entries.get(spaceId);
    return !entry || now - entry.checkedAt >= COUNT_TTL_MS;
  });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(COUNT_CONCURRENCY, targets.length) }, async () => {
    while (next < targets.length) {
      const spaceId = targets[next++]!;
      const inFlight = store.pending.get(spaceId);
      if (inFlight) {
        // Share another screen's probe instead of fetching the same page twice.
        await inFlight;
        continue;
      }
      const probe = (async () => {
        try {
          const response = await client.space(spaceId).sessions.list({ limit: SPACE_SESSION_COUNT_PAGE_SIZE });
          store.entries.set(spaceId, {
            count: response.sessions.length,
            hasMore: Boolean(response.pageInfo?.hasMore),
            checkedAt: Date.now(),
          });
        } catch {
          // Keep the entry missing/stale so the next focus retries.
        }
      })();
      store.pending.set(spaceId, probe);
      try {
        await probe;
      } finally {
        if (store.pending.get(spaceId) === probe) store.pending.delete(spaceId);
      }
    }
  }));
}

/** Space counts for the given ids; probes the API unless `probe` is false and re-syncs from the store. */
export function useSpaceSessionCounts(client: CohubClient | null, spaceIds: readonly string[], options: { probe?: boolean } = {}) {
  const probe = options.probe ?? true;
  const idsKey = [...new Set(spaceIds)].sort().join(",");
  const [counts, setCounts] = useState<SpaceSessionCounts>({});
  useEffect(() => {
    let active = true;
    const ids = idsKey ? idsKey.split(",") : [];
    const sync = () => {
      if (!active) return;
      const next: SpaceSessionCounts = {};
      for (const id of ids) {
        const count = getSpaceSessionCount(client, id);
        if (count) next[id] = count;
      }
      setCounts(next);
    };
    void Promise.resolve().then(() => {
      sync();
      if (probe && client && ids.length > 0) void loadSpaceSessionCounts(client, ids).then(sync);
    });
    return () => {
      active = false;
    };
  }, [client, idsKey, probe]);
  return counts;
}
