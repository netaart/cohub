import type { SpaceRecord } from "@neta-art/cohub";
import { Text, View } from "react-native";
import { PinnedRow } from "@/src/components/PinnedRow";
import { type SpaceSessionCount } from "@/src/data/space-session-counts";
import { Avatar, AppIcon, StatusPill } from "@/src/ui";
import { PressableScale } from "@/src/ui/PressableScale";
import { useAppTheme, typography } from "@/src/theme";
import { displaySpaceName, formatRelativeTime } from "@/src/utils";
import { useTranslation } from "@/src/i18n";

type SpaceRowProps = {
  space: SpaceRecord;
  sessionCount?: SpaceSessionCount | null;
  onPress: () => void;
  pinning?: boolean;
  onTogglePin?: () => void;
};

export function SpaceRow({ space, sessionCount, onPress, pinning = false, onTogglePin }: SpaceRowProps) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const name = displaySpaceName(space);
  const active = space.status === "running" || space.status === "bootstrapping";
  const pinned = space.isPinned === true;
  const countLabel = sessionCount
    ? sessionCount.hasMore
      ? t("space.chatCount.more", { count: sessionCount.count })
      : t(sessionCount.count === 1 ? "space.chatCount.one" : "space.chatCount.other", { count: sessionCount.count })
    : null;
  const subtitle = space.description?.trim() || countLabel;
  const content = <>
    <Avatar name={name} uri={space.publicProfile?.avatarUrl} size={50} online={active} />
    <View style={{ flex: 1, minWidth: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, flex: 1 }]}>{name}</Text>{active ? <StatusPill label={t("ui.active")} tone="success" /> : null}</View>
      {subtitle ? <Text numberOfLines={2} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 3 }]}>{subtitle}</Text> : null}
      <Text style={[typography.micro, { color: theme.colors.textFaint, marginTop: 3 }]}>{space.lastActivityAt ? t("ui.activeAgo", { time: formatRelativeTime(space.lastActivityAt) }) : t("space.readyForWork")}</Text>
    </View>
    <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} />
  </>;
  const rowStyle = { flexDirection: "row" as const, alignItems: "center" as const, gap: 13, minHeight: 80, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: "transparent" };
  const rowPressedStyle = { backgroundColor: theme.colors.surfacePressed };
  if (!onTogglePin) return <PressableScale accessibilityRole="button" accessibilityLabel={t("ui.openNamed", { name })} onPress={onPress} haptic style={rowStyle} pressedStyle={rowPressedStyle}>{content}</PressableScale>;
  return <PinnedRow
    openLabel={t("ui.openNamed", { name })}
    pinLabel={t("space.pin")}
    unpinLabel={t("space.unpin")}
    pinned={pinned}
    pinning={pinning}
    onPress={onPress}
    onTogglePin={() => onTogglePin()}
    rowStyle={rowStyle}
    rowPressedStyle={rowPressedStyle}
  >
    {content}
  </PinnedRow>;
}
