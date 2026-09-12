import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useApp } from "@/src/data/context";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, Avatar, IconButton, Screen, TopBar } from "@/src/ui";
import { displaySpaceName } from "@/src/utils";

type Params = { spaceId?: string | string[] };

export default function NewChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const initialSpaceId = Array.isArray(params.spaceId) ? params.spaceId[0] : params.spaceId;
  const theme = useAppTheme();
  const { t } = useTranslation();
  const { state } = useApp();
  const [selectedSpaceId, setSelectedSpaceId] = useState(initialSpaceId || "");

  const openSpaceDraft = (spaceId: string) => {
    setSelectedSpaceId(spaceId);
    router.replace({ pathname: "/chat/[sessionId]", params: { sessionId: "new", spaceId } });
  };

  return <Screen>
    <TopBar title={t("route.newChat")} actions={<IconButton name="x" label={t("ui.sheet.close", { title: t("route.newChat") })} onPress={() => router.back()} />} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 30 }}>
      <View>
        {state.spaces.map((space) => { const selected = selectedSpaceId === space.id; return <Pressable key={space.id} onPress={() => openSpaceDraft(space.id)} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 11, minHeight: 66, paddingHorizontal: 12, backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : "transparent", borderBottomWidth: 1, borderBottomColor: theme.colors.border })}><Avatar name={displaySpaceName(space)} uri={space.publicProfile?.avatarUrl} size={38} /><View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>{displaySpaceName(space)}</Text>{space.description ? <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>{space.description}</Text> : null}</View><AppIcon name="arrow-right" size={18} color={selected ? theme.colors.accent : theme.colors.textFaint} /></Pressable>; })}
        {state.spaces.length === 0 ? <View style={{ padding: 20 }}><Text style={[typography.body, { color: theme.colors.textMuted }]}>{t("newChat.noSpaces")}</Text></View> : null}
      </View>
    </ScrollView>
  </Screen>;
}
