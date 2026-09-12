import type { BillingCreditStatus } from "@neta-art/cohub";
import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { useApp } from "./context";
import { activityRange, tokenDays, type TokenDay } from "./activity";

type Resource<T> = { data: T | null; error: string | null };
type ActivityData = {
  credits: Resource<BillingCreditStatus>;
  days: Resource<TokenDay[]>;
};
const empty: ActivityData = {
  credits: { data: null, error: null }, days: { data: null, error: null },
};

export function useActivity() {
  const { client, userUuid, connectionState } = useApp();
  const [snapshot, setSnapshot] = useState({ client, userUuid, data: empty });
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!client || !userUuid) return;
    const request = ++generation.current;
    setLoading(true);
    const range = activityRange(new Date());
    async function load<K extends keyof ActivityData>(key: K, operation: () => Promise<NonNullable<ActivityData[K]["data"]>>) {
      try {
        const data = await operation();
        if (request === generation.current) setSnapshot((current) => ({ client, userUuid, data: { ...(current.client === client && current.userUuid === userUuid ? current.data : empty), [key]: { data, error: null } } }));
      } catch (error) {
        if (request === generation.current) setSnapshot((current) => {
          const data = current.client === client && current.userUuid === userUuid ? current.data : empty;
          return { client, userUuid, data: { ...data, [key]: { ...data[key], error: error instanceof Error ? error.message : "Unable to load activity. Please retry." } } };
        });
      }
    }
    await Promise.all([
      load("credits", () => client.billing.getCredits()),
      load("days", async () => tokenDays((await client.user.getActivity(range)).hourly, range.from, range.to)),
    ]);
    if (request === generation.current) setLoading(false);
  }, [client, userUuid]);
  useFocusEffect(useCallback(() => {
    if (connectionState === "reconnecting") return;
    void refresh();
    return () => { generation.current++; };
  }, [refresh, connectionState]));
  return { ...(snapshot.client === client && snapshot.userUuid === userUuid ? snapshot.data : empty), loading, refresh };
}
