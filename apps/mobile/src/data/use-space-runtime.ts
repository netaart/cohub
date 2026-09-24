import { useCallback, useEffect, useState } from "react";
import type { SpaceRuntimeStatus } from "@/src/data/runtime";
import { useApp } from "@/src/data/context";

export function useSpaceRuntime(spaceId: string) {
  const { client } = useApp();
  const [status, setStatus] = useState<SpaceRuntimeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!spaceId || !client) return;
    setLoading(true);
    setError(null);
    try {
      setStatus(await client.space(spaceId).getRuntime());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to check the local runtime.");
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [client, spaceId]);

  useEffect(() => {
    const task = Promise.resolve().then(() => refresh());
    return () => { void task.catch(() => undefined); };
  }, [refresh]);
  return { status, loading, error, refresh };
}
