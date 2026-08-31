import type { SpaceFsFileResponse } from "@neta-art/cohub";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, DetailTopBar, IconButton, LoadingRows, PrimaryButton, Screen } from "@/src/ui";

type Params = { spaceId?: string | string[]; path?: string | string[] };

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default function FileScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const spaceId = firstParam(params.spaceId);
  const path = Array.isArray(params.path) ? params.path.join("/") : params.path ?? "";
  const theme = useAppTheme();
  const { client } = useApp();
  const [file, setFile] = useState<SpaceFsFileResponse | null>(null);
  const requestIdRef = useRef(0);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryToken, setRetryToken] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const loadFile = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!client || !spaceId || !path) {
      setFile(null);
      setUrl(null);
      setLoading(false);
      setError(!spaceId ? "Space is unavailable." : !path ? "File path is missing." : "Connect to Cohub to open Files.");
      return;
    }

    setLoading(true);
    setError(null);
    setFile(null);
    setUrl(null);
    try {
      const result = await client.space(spaceId).files.read(path);
      if (requestId !== requestIdRef.current) return;
      if ("content" in result) {
        setFile(result);
        if (result.delivery === "url" && result.url) setUrl(result.url);
      } else {
        setError("This file is still being prepared. Try again shortly.");
      }
    } catch (caught) {
      if (requestId === requestIdRef.current) setError(caught instanceof Error ? caught.message : "Unable to open File");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [client, path, spaceId]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void loadFile();
    });
    return () => {
      active = false;
      requestIdRef.current += 1;
    };
  }, [loadFile, retryToken]);

  const title = path.split("/").pop() || "File";
  return (
    <Screen>
      <DetailTopBar
        title={title}
        subtitle={path || "Space workspace"}
        onBack={() => router.back()}
        actions={
          url ? (
            <IconButton
              name="external-link"
              label="Open externally"
              size={40}
              onPress={() => void Linking.openURL(url)}
            />
          ) : undefined
        }
      />
      {loading ? (
        <LoadingRows count={5} />
      ) : error ? (
        <FileError
          message={error}
          onRetry={() => setRetryToken((value) => value + 1)}
          onBack={() => router.back()}
        />
      ) : file && url && !isText(file.mimeType) ? (
        <WebView
          source={{ uri: url }}
          style={{ flex: 1, backgroundColor: theme.colors.background }}
          startInLoadingState
        />
      ) : file ? (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
          <Text selectable style={[styles.fileContent, { color: theme.colors.textSecondary }]}>
            {file.content}
          </Text>
        </ScrollView>
      ) : null}
    </Screen>
  );
}

function FileError({ message, onRetry, onBack }: { message: string; onRetry: () => void; onBack: () => void }) {
  const theme = useAppTheme();
  const isDirectory = /not a file|directory|folder/i.test(message);
  return (
    <View style={styles.errorState}>
      <View style={[styles.errorIcon, { backgroundColor: theme.colors.dangerSoft }]}>
        <AppIcon name={isDirectory ? "folder" : "cloud-off"} size={24} color={theme.colors.danger} />
      </View>
      <Text style={[typography.heading, { color: theme.colors.text, textAlign: "center", marginTop: 14 }]}>
        {isDirectory ? "This is a folder" : "Unable to open this file"}
      </Text>
      <Text selectable style={[typography.body, { color: theme.colors.textMuted, textAlign: "center", marginTop: 6, maxWidth: 320 }]}>
        {isDirectory ? "Open folders from the Files list to browse their contents." : message}
      </Text>
      <View style={styles.errorActions}>
        <PrimaryButton label="Back to Files" icon="arrow-left" onPress={onBack} style={{ minHeight: 44, paddingHorizontal: 14 }} />
        {!isDirectory ? <Pressable accessibilityRole="button" accessibilityLabel="Retry opening file" onPress={onRetry} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", paddingHorizontal: 12, opacity: pressed ? 0.6 : 1 })}><Text style={[typography.bodyMedium, { color: theme.colors.accent }]}>Retry</Text></Pressable> : null}
      </View>
    </View>
  );
}

function isText(mimeType: string | null) {
  return Boolean(
    mimeType?.startsWith("text/") ||
      mimeType?.includes("json") ||
      mimeType?.includes("javascript") ||
      mimeType?.includes("xml") ||
      mimeType?.includes("yaml"),
  );
}

const styles = {
  fileContent: {
    fontFamily: "SpaceMono",
    fontSize: 12,
    lineHeight: 19,
  },
  errorState: {
    flex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: 24,
  },
  errorIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  errorActions: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    marginTop: 18,
  },
} satisfies Record<string, object>;
