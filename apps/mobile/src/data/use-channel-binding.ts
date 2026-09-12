import type { Channel, CohubClient, SpaceRecord } from "@neta-art/cohub";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@/src/i18n";

export function useChannelBinding(client: CohubClient | null, channel: Channel, onChanged: () => void) {
  const { t } = useTranslation();
  const [spaces, setSpaces] = useState<SpaceRecord[]>([]);
  const [loading, setLoading] = useState(!channel.boundSpace);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    if (!client) { setError(t("settings.channels.connect")); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const next = await client.spaces.list();
      if (current === generation.current) setSpaces(next);
    } catch (caught) {
      if (current === generation.current) setError(caught instanceof Error ? caught.message : t("settings.channels.bindingError"));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [client, t]);
  useEffect(() => {
    let active = true;
    if (!channel.boundSpace) void Promise.resolve().then(() => { if (active) void load(); });
    return () => { active = false; generation.current += 1; };
  }, [channel.boundSpace, load]);

  const save = async (spaceId: string): Promise<void> => {
    if (!client || saving) return;
    setSaving(true);
    setError(null);
    const current = generation.current;
    try {
      if (channel.boundSpace) await client.space(channel.boundSpace.id).channels.unbind(channel.id);
      else await client.space(spaceId).channels.bind(channel.id);
      if (current === generation.current) onChanged();
    } catch (caught) {
      if (current === generation.current) setError(caught instanceof Error ? caught.message : t("settings.channels.bindingError"));
    } finally {
      if (current === generation.current) setSaving(false);
    }
  };
  return { spaces, loading, saving, error, load, save };
}
