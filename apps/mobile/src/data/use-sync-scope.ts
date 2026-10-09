import { useFocusEffect } from "expo-router";
import { useCallback, useLayoutEffect, useRef } from "react";
import { useApp } from "./context";

/** Route focus controls interest; the account scheduler owns foreground and timing. */
export function useSyncScope(key: string, run: () => Promise<void>, intervalMs: number, enabled = true, minRefreshMs = 2_000): void {
  const { sync, client } = useApp();
  const latest = useRef({ run, intervalMs });
  useLayoutEffect(() => { latest.current = { run, intervalMs }; }, [run, intervalMs]);
  useFocusEffect(useCallback(() => {
    if (!enabled || !client) return;
    return sync.watch(key, { run: () => latest.current.run(), intervalMs: () => latest.current.intervalMs, minRefreshMs });
  }, [client, enabled, key, minRefreshMs, sync]));
}
