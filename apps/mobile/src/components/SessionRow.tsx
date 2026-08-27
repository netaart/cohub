import type { UserSessionListItem } from "@neta-art/cohub";
import { Pressable, Text, View } from "react-native";
import { Avatar, AppIcon, StatusPill } from "@/src/ui";
import { useAppTheme, typography } from "@/src/theme";
import { displaySessionTitle, formatRelativeTime, isNeedsAttentionStatus, isRunningStatus, shortPreview } from "@/src/utils";

export function SessionRow({ session, onPress }: { session: UserSessionListItem; onPress: () => void }) {
  const theme = useAppTheme();
  const spaceName = session.space?.name?.trim() || "Space";
  const running = isRunningStatus(session.status);
  const attention = isNeedsAttentionStatus(session.status);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${displaySessionTitle(session)}`} onPress={onPress} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 76, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}>
      <Avatar name={spaceName} uri={session.space?.publicProfile?.avatarUrl} size={48} online={running} />
      <View style={{ flex: 1, minWidth: 0, alignSelf: "stretch", justifyContent: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, flex: 1 }]}>{displaySessionTitle(session)}</Text>
          <Text style={[typography.micro, { color: theme.colors.textFaint }]}>{formatRelativeTime(session.lastMessageAt ?? session.updatedAt)}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
          <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, flex: 1 }]}>{spaceName} · {shortPreview(session.latestMessageText, 84)}</Text>
          {running ? <StatusPill label="Running" tone="warning" /> : attention ? <StatusPill label="Needs you" tone="danger" /> : null}
        </View>
      </View>
      <AppIcon name="chevron-forward" size={16} color={theme.colors.textFaint} />
    </Pressable>
  );
}
