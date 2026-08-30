import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, Avatar, PrimaryButton, Screen, TopBar } from "@/src/ui";
import { displaySpaceName } from "@/src/utils";

type Params = { spaceId?: string | string[] };

export default function NewChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const initialSpaceId = Array.isArray(params.spaceId) ? params.spaceId[0] : params.spaceId;
  const theme = useAppTheme();
  const { state, createChat } = useApp();
  const [selectedSpaceId, setSelectedSpaceId] = useState(initialSpaceId || state.spaces[0]?.id || "");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedSpace = useMemo(() => state.spaces.find((space) => space.id === selectedSpaceId) ?? null, [selectedSpaceId, state.spaces]);

  const start = async () => {
    if (!selectedSpaceId || creating) return;
    setCreating(true);
    setError(null);
    try {
      const session = await createChat(selectedSpaceId, title);
      router.replace({ pathname: "/chat/[sessionId]", params: { sessionId: session.id } });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create Chat");
      setCreating(false);
    }
  };

  return <Screen>
    <TopBar title="New Chat" left={<Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => router.back()} hitSlop={8} style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}><AppIcon name="x" size={22} color={theme.colors.textSecondary} /></Pressable>} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 30 }}>
      <Text style={[typography.heading, { color: theme.colors.text }]}>Choose a Space</Text>
      <Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 5 }]}>Every Chat keeps its own files, context, and Agent history.</Text>
      <View style={{ marginTop: 16, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 14, overflow: "hidden", backgroundColor: theme.colors.surface }}>
        {state.spaces.map((space) => { const selected = selectedSpaceId === space.id; return <Pressable key={space.id} onPress={() => setSelectedSpaceId(space.id)} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 11, minHeight: 66, paddingHorizontal: 12, backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : "transparent", borderBottomWidth: 1, borderBottomColor: theme.colors.border })}><Avatar name={displaySpaceName(space)} uri={space.publicProfile?.avatarUrl} size={38} /><View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>{displaySpaceName(space)}</Text><Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>{space.description || "Ready for work"}</Text></View>{selected ? <AppIcon name="check-circle" size={21} color={theme.colors.accent} /> : <View style={{ width: 21, height: 21, borderRadius: 11, borderWidth: 1, borderColor: theme.colors.borderStrong }} />}</Pressable>; })}
        {state.spaces.length === 0 ? <View style={{ padding: 20 }}><Text style={[typography.body, { color: theme.colors.textMuted }]}>No accessible Spaces found.</Text></View> : null}
      </View>
      <Text style={[typography.heading, { color: theme.colors.text, marginTop: 26 }]}>Name the thread <Text style={{ color: theme.colors.textFaint, fontWeight: "400" }}>(optional)</Text></Text>
      <TextInput value={title} onChangeText={setTitle} maxLength={80} placeholder="e.g. Review the launch page" placeholderTextColor={theme.colors.textFaint} style={[typography.body, { color: theme.colors.text, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 13, minHeight: 48, paddingHorizontal: 13, marginTop: 10 }]} />
      {selectedSpace ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 13 }}><AppIcon name="info" size={15} color={theme.colors.textMuted} /><Text style={[typography.caption, { color: theme.colors.textMuted, flex: 1 }]}>This Chat will run inside {displaySpaceName(selectedSpace)}.</Text></View> : null}
      {error ? <Text style={[typography.caption, { color: theme.colors.danger, marginTop: 14 }]}>{error}</Text> : null}
      <PrimaryButton label="Start Chat" icon="arrow-right" loading={creating} disabled={!selectedSpaceId} onPress={() => void start()} style={{ marginTop: 26 }} />
    </ScrollView>
  </Screen>;
}
