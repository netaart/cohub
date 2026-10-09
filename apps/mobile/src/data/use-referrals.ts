import type { CohubClient, ReferralDashboard } from "@neta-art/cohub";
import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { useTranslation } from "@/src/i18n";

export function useReferrals(client: CohubClient | null) {
  const { t } = useTranslation();
  const [data, setData] = useState<ReferralDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    if (!client) { setError(t("settings.referrals.connect")); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const result = await client.referrals.getMine();
      if (current === generation.current) setData(result);
    } catch (caught) {
      if (current === generation.current) setError(caught instanceof Error ? caught.message : t("settings.referrals.error"));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [client, t]);
  useFocusEffect(useCallback(() => { void load(); return () => { generation.current += 1; }; }, [load]));
  const rotate = async (): Promise<boolean> => {
    if (!client || rotating) return false;
    setRotating(true);
    setError(null);
    const current = generation.current;
    try {
      const { code } = await client.referrals.rotateCode();
      if (current !== generation.current) return false;
      setData((previous) => previous ? { ...previous, code } : null);
      return true;
    } catch (caught) {
      if (current === generation.current) setError(caught instanceof Error ? caught.message : t("settings.referrals.error"));
      return false;
    } finally {
      if (current === generation.current) setRotating(false);
    }
  };
  return { data, loading, rotating, error, load, rotate };
}
