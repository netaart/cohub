import type { SpaceRecord } from "@neta-art/cohub";
import { Pressable, Text, View } from "react-native";
import { Avatar, AppIcon, StatusPill } from "@/src/ui";
import { useAppTheme, typography } from "@/src/theme";
import { displaySpaceName, formatRelativeTime } from "@/src/utils";

export function SpaceRow({ space, chatCount, onPress }: { space: SpaceRecord; chatCount: number; onPress: () => void }) {
  const theme = useAppTheme();
  const name = displaySpaceName(space);
  const active = space.status === "running" || space.status === "bootstrapping";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${name}`} onPress={onPress} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 13, minHeight: 84, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}>
      <Avatar name={name} uri={space.publicProfile?.avatarUrl} size={50} online={active} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, flex: 1 }]}>{name}</Text>{active ? <StatusPill label="Active" tone="success" /> : null}</View>
        <Text numberOfLines={2} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 4 }]}>{space.description?.trim() || `${chatCount} ${chatCount === 1 ? "Chat" : "Chats"}`}</Text>
        <Text style={[typography.micro, { color: theme.colors.textFaint, marginTop: 5 }]}>{space.lastActivityAt ? `Active ${formatRelativeTime(space.lastActivityAt)} ago` : "Ready for work"}</Text>
      </View>
      <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} />
    </Pressable>
  );
}
