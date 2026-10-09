import type { BillingBalanceActivityList, BillingSubscriptionHistoryList, BillingSubscriptionHistoryStatus } from "@neta-art/cohub";
import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { useApp } from "@/src/data/context";
import { useTranslation } from "@/src/i18n";

type HistoryData = { kind: "history"; list: BillingBalanceActivityList } | { kind: "subscriptions"; list: BillingSubscriptionHistoryList };
export type SubscriptionCancellation = { subscription: BillingSubscriptionHistoryStatus; kind: "checkout" | "renewal" };

export function useBillingHistory(kind: HistoryData["kind"]) {
  const { client } = useApp();
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    const current = ++generation.current;
    if (!client) { setError(t("settings.billing.connect")); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const next: HistoryData = kind === "history"
        ? { kind, list: (await client.billing.getBalanceActivities({ page, limit: 20 })).activities }
        : { kind, list: (await client.billing.getSubscriptions({ page, limit: 20 })).subscriptions };
      if (current === generation.current) setData(next);
    } catch (caught) {
      if (current === generation.current) setError(caught instanceof Error ? caught.message : t("settings.billing.error"));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [client, kind, page, t]);
  useFocusEffect(useCallback(() => { void load(); return () => { generation.current += 1; }; }, [load]));

  const cancel = async ({ subscription, kind: action }: SubscriptionCancellation): Promise<boolean> => {
    if (!client || saving) return false;
    setSaving(true);
    setError(null);
    const current = generation.current;
    try {
      const result = action === "checkout"
        ? await client.billing.cancelSubscriptionCheckout(subscription.id)
        : await client.billing.cancelSubscriptionAutoRenew(subscription.id);
      if (current !== generation.current) return false;
      setData((previous) => previous?.kind === "subscriptions" ? { ...previous, list: { ...previous.list, items: previous.list.items.map((item) => item.id === subscription.id ? result.subscription : item) } } : previous);
      return true;
    } catch (caught) {
      if (current === generation.current) setError(caught instanceof Error ? caught.message : t("settings.billing.error"));
      return false;
    } finally {
      if (current === generation.current) setSaving(false);
    }
  };
  return { data, page, setPage, loading, saving, error, load, cancel };
}
