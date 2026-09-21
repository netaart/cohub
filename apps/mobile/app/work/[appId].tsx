import type { AppDetailResponse } from "@neta-art/cohub";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { useApp } from "@/src/data/context";
import { openWebLink } from "@/src/platform/browser";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { DataError, TopBar, IconButton, LoadingRows, Screen } from "@/src/ui";

type Params = { appId?: string | string[] };

export default function WorkScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const appId = Array.isArray(params.appId) ? params.appId[0] : params.appId;
  const theme = useAppTheme();
  const { t } = useTranslation();
  const { client } = useApp();
  const [detail, setDetail] = useState<AppDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const contentUrl = detail?.content?.url ?? null;
  const initialOrigin = useMemo(() => {
    if (!contentUrl) return null;
    try { return new URL(contentUrl).origin; } catch { return null; }
  }, [contentUrl]);

  const load = useCallback(async () => {
    if (!client || !appId) return;
    const request = ++generation.current;
    setError(null);
    try {
      const result = await client.apps.get(appId);
      if (request === generation.current) setDetail(result);
    } catch (caught) {
      if (request === generation.current) setError(caught instanceof Error ? caught.message : t("work.error"));
    }
  }, [appId, client, t]);
  useFocusEffect(useCallback(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]));

  const title = detail?.app.meta?.title || detail?.app.meta?.name || detail?.app.slug || t("work.fallbackTitle");
  return <Screen>
    <TopBar 
      title={title} 
      subtitle={detail?.space.name || t("work.published")} 
      onBack={() => router.back()} 
      actions={(
        <>
          {detail && <IconButton name="square-pen" label={t("app.edit.action")} size={40} onPress={() => router.push({ pathname: "/work/[appId]/edit", params: { appId: detail.app.id } })} />}
          {contentUrl && <IconButton name="external-link" label={t("file.openExternally")} size={40} onPress={() => void openWebLink(contentUrl).catch(() => undefined)} />}
        </>
      )} 
    />
    {error ? <DataError message={error} onRetry={() => void load()} /> : null}
    {!detail ? (error ? null : <LoadingRows count={6} />) : !contentUrl ? <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}><Text style={[typography.body, { color: theme.colors.textMuted, textAlign: "center" }]}>{t("work.noContent")}</Text></View> : <WebView
      source={{ uri: contentUrl }}
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      originWhitelist={["https://*"]}
      javaScriptEnabled
      domStorageEnabled
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      allowsBackForwardNavigationGestures
      setSupportMultipleWindows={false}
      onShouldStartLoadWithRequest={(request) => {
        try {
          const url = new URL(request.url);
          if (url.protocol !== "https:") return false;
          if (!initialOrigin || url.origin === initialOrigin) return true;
          void openWebLink(request.url).catch(() => undefined);
          return false;
        } catch {
          return false;
        }
      }}
      startInLoadingState
    />}
  </Screen>;
}
