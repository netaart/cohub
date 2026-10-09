import type { SpaceRecord, UserRulesResponse } from "@neta-art/cohub";
import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { useApp } from "@/src/data/context";
import { useTranslation } from "@/src/i18n";

export function useUserRules() {
  const { client, userUuid, createSpace } = useApp();
  const { t } = useTranslation();
  const [data, setData] = useState<UserRulesResponse | null>(null);
  const [configSpace, setConfigSpace] = useState<SpaceRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    if (!client) { setError(t("settings.rules.connect")); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const [rules, spaces] = await Promise.all([client.user.getRules(), client.spaces.list()]);
      if (current !== generation.current) return;
      setData(rules);
      setConfigSpace(spaces.find((space) => space.name === "config" && space.userUuid === userUuid) ?? null);
    } catch (caught) {
      if (current === generation.current) setError(caught instanceof Error ? caught.message : t("settings.rules.error"));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [client, t, userUuid]);
  useFocusEffect(useCallback(() => { void load(); return () => { generation.current += 1; }; }, [load]));
  const openConfig = async (): Promise<SpaceRecord | null> => {
    if (creating) return null;
    if (configSpace) return configSpace;
    setCreating(true);
    setError(null);
    const current = generation.current;
    try {
      const space = await createSpace("config", "Personal Cohub configuration. Edit AGENTS.md here, then create a Save to publish user rules.");
      if (current !== generation.current) return null;
      setConfigSpace(space);
      return space;
    } catch (caught) {
      if (current === generation.current) setError(caught instanceof Error ? caught.message : t("settings.rules.error"));
      return null;
    } finally {
      if (current === generation.current) setCreating(false);
    }
  };
  return { data, configSpace, loading, creating, error, load, openConfig };
}
