import type { BillingCreditStatus, UserActivityResponse } from "@neta-art/cohub";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSyncScope } from "./use-sync-scope";
import { useFocusEffect } from "expo-router";
import { useApp } from "./context";
import { activityRange, tokenDays, type TokenDay } from "./activity";

type Resource<T> = { data: T | null; error: string | null };
type ActivityData = {
  credits: Resource<BillingCreditStatus>;
  days: Resource<TokenDay[]>;
  activity: Resource<UserActivityResponse>;
};
const ACTIVITY_POLL_INTERVAL_MS = 60_000;
const empty: ActivityData = {
  credits: { data: null, error: null }, days: { data: null, error: null }, activity: { data: null, error: null },
};

export function useActivity() {
  const { client, userUuid } = useApp();
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
      const errors: unknown[] = [];
      async function load<K extends keyof ActivityData>(key: K, operation: () => Promise<NonNullable<ActivityData[K]["data"]>>) {
        try {
          const data = await operation();
          if (requestGeneration === generation.current) setSnapshot((current) => ({ client, userUuid, data: { ...(current.client === client && current.userUuid === userUuid ? current.data : empty), [key]: { data, error: null } } }));
        } catch (error) {
          errors.push(error);
          if (requestGeneration === generation.current) setSnapshot((current) => {
            const data = current.client === client && current.userUuid === userUuid ? current.data : empty;
            return { client, userUuid, data: { ...data, [key]: { ...data[key], error: error instanceof Error ? error.message : "Unable to load activity. Please retry." } } };
          });
        }
      }
      await Promise.all([
        load("credits", () => client.billing.getCredits()),
        load("activity", () => client.user.getActivity(range)),
        load("days", async () => {
          const activityData = await client.user.getActivity(range);
          return tokenDays(activityData.hourly, range.from, range.to);
        }),
      ]);
      if (requestGeneration === generation.current && !options.silent) setLoading(false);
      if (options.silent && errors.length) throw errors[0];
    })();
    refreshRequest.current = request;
    void request.finally(() => {
      if (refreshRequest.current === request) refreshRequest.current = null;
    }).catch(() => undefined);
    return request;
  }, [client, userUuid]);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
  useEffect(() => () => { generation.current += 1; refreshRequest.current = null; }, [client, userUuid]);
  useSyncScope("activity", () => refresh({ silent: true }), ACTIVITY_POLL_INTERVAL_MS);
  return { ...(snapshot.client === client && snapshot.userUuid === userUuid ? snapshot.data : empty), loading, refresh };
}
