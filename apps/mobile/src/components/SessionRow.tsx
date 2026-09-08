import type { UserSessionListItem } from "@neta-art/cohub";
import { Text, View } from "react-native";
import { Avatar, AppIcon, StatusPill } from "@/src/ui";
import { PressableScale } from "@/src/ui/PressableScale";
import { useAppTheme, typography } from "@/src/theme";
import { displaySessionTitle, formatRelativeTime, shortPreview } from "@/src/utils";
import { getSessionStatus, sessionStatusLabels } from "@/src/data/session-status";

type SessionRowProps = {
  session: UserSessionListItem;
  onPress: () => void;
  /** Long-press opens label management (only when connected). */
  onLongPress?: () => void;
  /** Labels shown as small chips under the preview line. */
  labels?: { id: string; name: string; system: boolean }[];
};

export function SessionRow({ session, onPress, onLongPress, labels = [] }: SessionRowProps) {
  const theme = useAppTheme();
  const spaceName = session.space?.name?.trim() || "Space";
  const sessionStatus = getSessionStatus(session.status);
  const running = sessionStatus === "running";
  const rowContent = <>
    <Avatar name={spaceName} uri={session.space?.publicProfile?.avatarUrl} size={48} online={running} />
    <View style={{ flex: 1, minWidth: 0, alignSelf: "stretch", justifyContent: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, flex: 1 }]}>{displaySessionTitle(session)}</Text>
        <Text style={[typography.micro, { color: theme.colors.textFaint }]}>{formatRelativeTime(session.lastMessageAt ?? session.updatedAt)}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
        <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, flex: 1 }]}>{spaceName} · {shortPreview(session.latestMessageText, 84)}</Text>
        {sessionStatus === "running" ? <StatusPill label={sessionStatusLabels.running} tone="warning" /> : sessionStatus === "failed" ? <StatusPill label={sessionStatusLabels.failed} tone="danger" /> : sessionStatus === "stopped" ? <StatusPill label={sessionStatusLabels.stopped} tone="neutral" /> : null}
      </View>
      {labels.length > 0 ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
        {labels.slice(0, 3).map((label) => <View key={label.id} style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: label.system ? theme.colors.infoSoft : theme.colors.accentSoft }}>
          <Text numberOfLines={1} style={[typography.micro, { color: label.system ? theme.colors.info : theme.colors.accent }]}>{label.name}</Text>
        </View>)}
        {labels.length > 3 ? <View style={{ paddingHorizontal: 6, paddingVertical: 2, justifyContent: "center" }}><Text style={[typography.micro, { color: theme.colors.textFaint }]}>+{labels.length - 3}</Text></View> : null}
      </View> : null}
    </View>
    <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} />
  </>;
  const rowStyle = { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, minHeight: 78, paddingHorizontal: 16, paddingVertical: 11, backgroundColor: "transparent" };
  const rowPressedStyle = { backgroundColor: theme.colors.surfacePressed };
  return <PressableScale accessibilityRole="button" accessibilityLabel={`Open ${displaySessionTitle(session)}`} onPress={onPress} onLongPress={onLongPress} haptic style={rowStyle} pressedStyle={rowPressedStyle}>{rowContent}</PressableScale>;
}
