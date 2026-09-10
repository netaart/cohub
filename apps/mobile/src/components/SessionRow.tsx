import type { UserSessionListItem } from "@neta-art/cohub";
import { Text, View } from "react-native";
import { Avatar, AppIcon, StatusPill } from "@/src/ui";
import { PressableScale } from "@/src/ui/PressableScale";
import { useAppTheme, typography } from "@/src/theme";
import { displaySessionTitle, formatRelativeTime, shortPreview } from "@/src/utils";
import { getSessionStatus } from "@/src/data/session-status";
import { useApp } from "@/src/data/context";
import { useTranslation } from "@/src/i18n";

type SessionRowProps = {
  session: UserSessionListItem;
  onPress: () => void;
  /** Long-press opens label management (only when connected). */
  onLongPress?: () => void;
  /** Labels shown as small chips under the preview line. */
  labels?: { id: string; name: string; system: boolean }[];
  showSpace?: boolean;
};

export function SessionRow({ session, onPress, onLongPress, labels = [], showSpace = true }: SessionRowProps) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const { state } = useApp();
  const spaceName = session.space?.name?.trim() || t("space.fallbackName");
  const sessionStatus = getSessionStatus(state.sessionLatestTurns[session.id]?.status);
  const running = sessionStatus === "running";
  const rowContent = <>
    {showSpace ? <Avatar name={spaceName} uri={session.space?.publicProfile?.avatarUrl} size={48} online={running} /> : null}
    <View style={{ flex: 1, minWidth: 0, alignSelf: "stretch", justifyContent: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, flex: 1 }]}>{displaySessionTitle(session)}</Text>
        <Text style={[typography.micro, { color: theme.colors.textFaint }]}>{formatRelativeTime(session.lastMessageAt ?? session.updatedAt)}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
        <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, flex: 1 }]}>{showSpace ? `${spaceName} · ` : ""}{shortPreview(session.latestMessageText, 84)}</Text>
        {sessionStatus === "running" ? <StatusPill label={t("ui.status.running")} tone="warning" /> : sessionStatus === "failed" ? <StatusPill label={t("ui.status.failed")} tone="danger" /> : sessionStatus === "stopped" ? <StatusPill label={t("ui.status.stopped")} tone="neutral" /> : null}
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
  const rowStyle = { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, minHeight: showSpace ? 76 : 68, paddingHorizontal: showSpace ? 18 : 16, paddingVertical: 10, backgroundColor: "transparent", borderBottomWidth: 1, borderBottomColor: theme.colors.border };
  const rowPressedStyle = { backgroundColor: theme.colors.surfacePressed };
  return <PressableScale accessibilityRole="button" accessibilityLabel={t("ui.openNamed", { name: displaySessionTitle(session) })} onPress={onPress} onLongPress={onLongPress} haptic style={rowStyle} pressedStyle={rowPressedStyle}>{rowContent}</PressableScale>;
}
