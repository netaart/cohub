import type { AppDetailResponse } from "@neta-art/cohub";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Linking, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { useApp } from "@/src/data/context";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { TopBar, IconButton, LoadingRows, Screen } from "@/src/ui";

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
  const contentUrl = detail?.content?.url ?? null;
  const initialOrigin = useMemo(() => {
    if (!contentUrl) return null;
    try { return new URL(contentUrl).origin; } catch { return null; }
  }, [contentUrl]);

  useEffect(() => {
    if (!client || !appId) return;
    let active = true;
    void client.apps.get(appId).then((result) => {
      if (active) setDetail(result);
    }).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : t("work.error"));
    });
    return () => { active = false; };
  }, [appId, client, t]);

  const title = detail?.app.meta?.title || detail?.app.meta?.name || detail?.app.slug || t("work.fallbackTitle");
  return <Screen>
    <TopBar title={title} subtitle={detail?.space.name || t("work.published")} onBack={() => router.back()} actions={contentUrl ? <IconButton name="external-link" label={t("file.openExternally")} size={40} onPress={() => void Linking.openURL(contentUrl)} /> : undefined} />
    {error ? <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}><Text style={[typography.body, { color: theme.colors.danger, textAlign: "center" }]}>{error}</Text></View> : !detail ? <LoadingRows count={6} /> : !contentUrl ? <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}><Text style={[typography.body, { color: theme.colors.textMuted, textAlign: "center" }]}>{t("work.noContent")}</Text></View> : <WebView
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
          void Linking.openURL(request.url);
          return false;
        } catch {
          return false;
        }
      }}
      startInLoadingState
    />}
  </Screen>;
}
