import type { CohubClient, PaletteOverviewResponse } from "@neta-art/cohub";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadSpaceListCache, loadSpaceVisits, saveSpaceListCache, saveSpaceVisit } from "./local-db";
import { recentSpaceVisits, type SpaceVisit } from "./space-list";

export function useSpaceListData(client: CohubClient | null, userKey: string) {
  const [overview, setOverview] = useState<PaletteOverviewResponse | null>(null);
  const [visits, setVisits] = useState<SpaceVisit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const visitsRef = useRef<SpaceVisit[]>([]);
  const hydration = useRef<Promise<void>>(Promise.resolve());
  const refreshRequest = useRef<Promise<void> | null>(null);

  useLayoutEffect(() => {
    const token = ++generation.current;
    hydration.current = Promise.all([loadSpaceListCache(userKey), loadSpaceVisits(userKey)]).then(([cached, stored]) => {
      if (generation.current !== token) return;
      setOverview(cached);
      const merged = recentSpaceVisits([...stored, ...visitsRef.current], Date.now());
      visitsRef.current = merged;
      setVisits(merged);
    }).catch(() => {
      if (generation.current === token) setError("Could not load recent Spaces. Pull to refresh to retry.");
    });
    return () => { generation.current += 1; };
  }, [userKey]);

  const refresh = useCallback((options: { silent?: boolean } = {}): Promise<void> => {
    if (refreshRequest.current) return refreshRequest.current;
    const request = (async () => {
      if (!client) return;
      const beforeHydration = generation.current;
      await hydration.current;
      if (generation.current !== beforeHydration) return;
      const token = ++generation.current;
      if (!options.silent) setLoading(true);
      if (!options.silent) setError(null);
      try {
        const data = await client.search.overview({ spaceLimit: 50, recentSpaceIds: recentSpaceVisits(visitsRef.current, Date.now()).map((visit) => visit.spaceId) });
        if (generation.current !== token) return;
        setOverview(data);
        setError(null);
        await saveSpaceListCache(userKey, data);
      } catch (error) {
        if (generation.current === token) setError("Could not refresh recent Spaces. Check your connection and retry.");
        if (options.silent) throw error;
      } finally {
        if (generation.current === token) setLoading(false);
      }
    })();
    refreshRequest.current = request;
    void request.finally(() => {
      if (refreshRequest.current === request) refreshRequest.current = null;
    }).catch(() => undefined);
    return request;
  }, [client, userKey]);

  const recordVisit = useCallback((spaceId: string): void => {
    if (!spaceId.trim()) throw new Error("Cannot record a Space visit without a Space ID.");
    const timestamp = Date.now();
    const next = recentSpaceVisits([{ spaceId, timestamp }, ...visitsRef.current], timestamp);
    visitsRef.current = next;
    setVisits(next);
    void saveSpaceVisit(userKey, spaceId, timestamp).catch(() => setError("Could not save your recent Space visit. Try opening the Space again."));
  }, [userKey]);

  const reset = useCallback(() => {
    generation.current += 1;
    visitsRef.current = [];
    setVisits([]);
    setOverview(null);
    setError(null);
    setLoading(false);
  }, []);

  return useMemo(() => ({ overview, visits, loading, error, refresh, recordVisit, reset }), [overview, visits, loading, error, refresh, recordVisit, reset]);
}
