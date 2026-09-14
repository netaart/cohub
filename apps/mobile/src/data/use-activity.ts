import type { BillingCreditStatus } from "@neta-art/cohub";
import { useCallback, useRef, useState } from "react";
import { AppState as NativeAppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { useApp } from "./context";
import { activityRange, tokenDays, type TokenDay } from "./activity";

type Resource<T> = { data: T | null; error: string | null };
type ActivityData = {
  credits: Resource<BillingCreditStatus>;
  days: Resource<TokenDay[]>;
};
const ACTIVITY_POLL_INTERVAL_MS = 60_000;
const empty: ActivityData = {
  credits: { data: null, error: null }, days: { data: null, error: null },
};

export function useActivity() {
  const { client, userUuid, connectionState } = useApp();
  const [snapshot, setSnapshot] = useState({ client, userUuid, data: empty });
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refreshRequest = useRef<Promise<void> | null>(null);
  const refresh = useCallback((options: { silent?: boolean } = {}): Promise<void> => {
    if (refreshRequest.current) return refreshRequest.current;
    const request = (async () => {
      if (!client || !userUuid) return;
      const requestGeneration = ++generation.current;
      if (!options.silent) setLoading(true);
      const range = activityRange(new Date());
      async function load<K extends keyof ActivityData>(key: K, operation: () => Promise<NonNullable<ActivityData[K]["data"]>>) {
        try {
          const data = await operation();
          if (requestGeneration === generation.current) setSnapshot((current) => ({ client, userUuid, data: { ...(current.client === client && current.userUuid === userUuid ? current.data : empty), [key]: { data, error: null } } }));
        } catch (error) {
          if (requestGeneration === generation.current && !options.silent) setSnapshot((current) => {
            const data = current.client === client && current.userUuid === userUuid ? current.data : empty;
            return { client, userUuid, data: { ...data, [key]: { ...data[key], error: error instanceof Error ? error.message : "Unable to load activity. Please retry." } } };
          });
        }
      }
      await Promise.all([
        load("credits", () => client.billing.getCredits()),
        load("days", async () => tokenDays((await client.user.getActivity(range)).hourly, range.from, range.to)),
      ]);
      if (requestGeneration === generation.current && !options.silent) setLoading(false);
    })();
    refreshRequest.current = request;
    void request.finally(() => {
      if (refreshRequest.current === request) refreshRequest.current = null;
    }).catch(() => undefined);
    return request;
  }, [client, userUuid]);
  useFocusEffect(useCallback(() => {
    if (connectionState === "reconnecting") return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stopPolling = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const startPolling = () => {
      stopPolling();
      timer = setInterval(() => void refresh({ silent: true }), ACTIVITY_POLL_INTERVAL_MS);
    };
    void refresh();
    startPolling();
    const subscription = NativeAppState.addEventListener("change", (next) => {
      if (next !== "active") {
        stopPolling();
        return;
      }
      void refresh({ silent: true });
      startPolling();
    });
    return () => {
      stopPolling();
      subscription.remove();
      generation.current++;
    };
  }, [refresh, connectionState]));
  return { ...(snapshot.client === client && snapshot.userUuid === userUuid ? snapshot.data : empty), loading, refresh };
}
