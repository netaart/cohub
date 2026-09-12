import type { CohubClient } from "@neta-art/cohub";
import { useCallback, useMemo, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { createSettingsChannel, createWeChatLoginPoller, missingChannelField, type ChannelDraft, type ChannelProvider } from "./channel-settings";
import { useTranslation } from "@/src/i18n";

type Login = { sessionKey: string; qrDataUrl: string; expiresAt: number; message: string; needsCode: boolean; expired: boolean };

export function useNewChannel(client: CohubClient | null, provider: ChannelProvider, onCreated: () => void) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ChannelDraft>({ name: "", token: "", appId: "", secret: "", brand: "feishu" });
  const [login, setLogin] = useState<Login | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef(0);
  const submitting = useRef(false);
  const poller = useMemo(() => client ? createWeChatLoginPoller((input) => client.channels.waitWeChatLogin(input)) : null, [client]);
  const fail = useCallback((caught: unknown) => {
    setBusy(false);
    submitting.current = false;
    setError(caught instanceof Error ? caught.message : t("settings.channels.createError"));
  }, [t]);
  const poll = useCallback((session: Login, code?: string) => {
    setBusy(true);
    poller?.start(session.sessionKey, session.expiresAt, (status) => {
      if (status.connected) {
        setBusy(false);
        setDraft({ name: "", token: "", appId: "", secret: "", brand: "feishu" });
        onCreated();
        return;
      }
      setLogin((current) => current ? { ...current, message: status.message, needsCode: Boolean(status.needVerifyCode), expired: Boolean(status.expired) } : null);
      if (status.needVerifyCode || status.expired) setBusy(false);
    }, fail, code);
  }, [fail, onCreated, poller]);

  useFocusEffect(useCallback(() => {
    return () => { operation.current += 1; submitting.current = false; poller?.stop(); };
  }, [poller]));

  const submit = async (): Promise<void> => {
    if (submitting.current || busy) return;
    const missing = missingChannelField(provider, draft);
    if (missing) { setError(t("settings.channels.required", { field: t(`settings.channels.field.${missing}`) })); return; }
    if (!client) { setError(t("settings.channels.connect")); return; }
    submitting.current = true;
    const current = ++operation.current;
    setBusy(true);
    setError(null);
    try {
      if (provider === "wechat") {
        poller?.stop();
        const result = await client.channels.startWeChatLogin({ name: draft.name.trim() });
        if (current !== operation.current) return;
        const next: Login = { ...result, expiresAt: Date.now() + result.expiresInSeconds * 1000, needsCode: false, expired: false };
        setLogin(next);
        submitting.current = false;
        poll(next);
      } else {
        await createSettingsChannel(client, provider, draft);
        if (current !== operation.current) return;
        setDraft({ name: "", token: "", appId: "", secret: "", brand: "feishu" });
        setBusy(false);
        submitting.current = false;
        onCreated();
      }
    } catch (caught) {
      if (current === operation.current) fail(caught);
    }
  };

  const verify = (code: string): void => {
    if (busy || !login) return;
    if (!code.trim()) { setError(t("settings.channels.codeRequired")); return; }
    setError(null);
    setLogin({ ...login, needsCode: false });
    poll(login, code.trim());
  };

  const cancelLogin = (): void => {
    operation.current += 1;
    submitting.current = false;
    poller?.stop();
    setLogin(null);
    setBusy(false);
    setError(null);
  };

  return { draft, setDraft, login, busy, error, submit, verify, cancelLogin };
}
