import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, Avatar, Screen, TopBar } from "@/src/ui";
import { displaySpaceName } from "@/src/utils";

type Params = { spaceId?: string | string[] };

export default function NewChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const initialSpaceId = Array.isArray(params.spaceId) ? params.spaceId[0] : params.spaceId;
  const theme = useAppTheme();
  const { state } = useApp();
  const [selectedSpaceId, setSelectedSpaceId] = useState(initialSpaceId || "");

  const openSpaceDraft = (spaceId: string) => {
    setSelectedSpaceId(spaceId);
    router.replace({ pathname: "/chat/[sessionId]", params: { sessionId: "new", spaceId } });
  };

  return <Screen>
    <TopBar title="Choose a Space" subtitle="Start a conversation where your work lives" left={<Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => router.back()} hitSlop={8} style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}><AppIcon name="x" size={22} color={theme.colors.textSecondary} /></Pressable>} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 30 }}>
      <Text style={[typography.body, { color: theme.colors.textMuted }]}>Choose a Space to open its conversation composer. The first message will give the Chat its title automatically.</Text>
      <View style={{ marginTop: 16, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 14, overflow: "hidden", backgroundColor: theme.colors.surface }}>
        {state.spaces.map((space) => { const selected = selectedSpaceId === space.id; return <Pressable key={space.id} onPress={() => openSpaceDraft(space.id)} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 11, minHeight: 66, paddingHorizontal: 12, backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : "transparent", borderBottomWidth: 1, borderBottomColor: theme.colors.border })}><Avatar name={displaySpaceName(space)} uri={space.publicProfile?.avatarUrl} size={38} /><View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>{displaySpaceName(space)}</Text><Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>{space.description || "Ready for work"}</Text></View><AppIcon name="arrow-right" size={18} color={selected ? theme.colors.accent : theme.colors.textFaint} /></Pressable>; })}
        {state.spaces.length === 0 ? <View style={{ padding: 20 }}><Text style={[typography.body, { color: theme.colors.textMuted }]}>No accessible Spaces found.</Text></View> : null}
      </View>
    </ScrollView>
  </Screen>;
}
