import type { SpaceFsEntry } from "@neta-art/cohub";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, IconButton, LoadingRows, Screen, TopBar } from "@/src/ui";
import { displaySpaceName, formatRelativeTime } from "@/src/utils";

type Params = { spaceId?: string | string[] };

export default function FilesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const spaceId = Array.isArray(params.spaceId) ? params.spaceId[0] : params.spaceId;
  const theme = useAppTheme();
  const { client, state } = useApp();
  const space = state.spaces.find((item) => item.id === spaceId);
  const [entries, setEntries] = useState<SpaceFsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!client || !spaceId) return;
    let active = true;
    setLoading(true);
    void client.space(spaceId).files.list().then((result) => { if (active) { setEntries(result.entries); setError(null); } }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Unable to load Files"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, spaceId]);
  return <Screen>
    <TopBar title="Files" subtitle={space ? displaySpaceName(space) : "Space workspace"} left={<IconButton name="arrow-back" label="Back" size={40} onPress={() => router.back()} />} right={<IconButton name="refresh-outline" label="Refresh files" size={40} onPress={() => router.replace({ pathname: "/space/[spaceId]/files", params: { spaceId: spaceId ?? "" } })} />} />
    {loading ? <LoadingRows count={6} /> : error ? <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}><AppIcon name="cloud-offline-outline" size={25} color={theme.colors.danger} /><Text style={[typography.body, { color: theme.colors.danger, textAlign: "center", marginTop: 10 }]}>{error}</Text></View> : <FlatList data={entries} keyExtractor={(item) => item.path} contentContainerStyle={{ paddingVertical: 10, paddingBottom: 28, flexGrow: entries.length === 0 ? 1 : undefined }} renderItem={({ item }) => <Pressable onPress={() => router.push({ pathname: "/space/[spaceId]/file", params: { spaceId: spaceId ?? "", path: item.path } })} style={({ pressed }) => ({ minHeight: 63, flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 16, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent", borderBottomWidth: 1, borderBottomColor: theme.colors.border })}><View style={{ width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: item.type === "dir" ? theme.colors.accentSoft : theme.colors.surface }}><AppIcon name={item.type === "dir" ? "folder-outline" : "document-text-outline"} size={17} color={item.type === "dir" ? theme.colors.accent : theme.colors.textMuted} /></View><View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>{item.name}</Text><Text numberOfLines={1} style={[typography.micro, { color: theme.colors.textMuted, marginTop: 3 }]}>{item.type === "dir" ? "Directory" : `${item.mimeType || "File"} · ${formatBytes(item.size)}`}</Text></View><Text style={[typography.micro, { color: theme.colors.textFaint }]}>{item.mtimeMs ? formatRelativeTime(new Date(item.mtimeMs).toISOString()) : ""}</Text><AppIcon name="chevron-forward" size={16} color={theme.colors.textFaint} /></Pressable>} ListEmptyComponent={<View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}><AppIcon name="folder-open-outline" size={26} color={theme.colors.textMuted} /><Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 10 }]}>This workspace is empty.</Text></View>} />}
  </Screen>;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
