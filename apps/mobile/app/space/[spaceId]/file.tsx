import type { SpaceFsFileResponse } from "@neta-art/cohub";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { IconButton, LoadingRows, Screen, TopBar } from "@/src/ui";

type Params = { spaceId?: string | string[]; path?: string | string[] };

export default function FileScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const spaceId = Array.isArray(params.spaceId) ? params.spaceId[0] : params.spaceId;
  const path = Array.isArray(params.path) ? params.path.join("/") : params.path;
  const theme = useAppTheme();
  const { client } = useApp();
  const [file, setFile] = useState<SpaceFsFileResponse | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!client || !spaceId || !path) return;
    let active = true;
    void client.space(spaceId).files.read(path).then(async (result) => {
      if (!active) return;
      if ("content" in result) {
        setFile(result);
        if (result.delivery === "url" && result.url) setUrl(result.url);
      } else {
        setError("This file is still being prepared. Try again shortly.");
      }
    }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Unable to open file"); });
    return () => { active = false; };
  }, [client, path, spaceId]);
  return <Screen>
    <TopBar title={path?.split("/").pop() || "File"} subtitle={path} left={<IconButton name="arrow-back" label="Back" size={40} onPress={() => router.back()} />} right={url ? <IconButton name="open-outline" label="Open externally" size={40} onPress={() => void Linking.openURL(url)} /> : undefined} />
    {error ? <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}><Text style={[typography.body, { color: theme.colors.danger, textAlign: "center" }]}>{error}</Text></View> : !file ? <LoadingRows count={5} /> : url && !isText(file.mimeType) ? <WebView source={{ uri: url }} style={{ flex: 1, backgroundColor: theme.colors.background }} startInLoadingState /> : <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}><Text selectable style={{ color: theme.colors.textSecondary, fontFamily: "SpaceMono", fontSize: 12, lineHeight: 19 }}>{file.content}</Text></ScrollView>}
  </Screen>;
}

function isText(mimeType: string | null) {
  return Boolean(mimeType?.startsWith("text/") || mimeType?.includes("json") || mimeType?.includes("javascript") || mimeType?.includes("xml") || mimeType?.includes("yaml"));
}
