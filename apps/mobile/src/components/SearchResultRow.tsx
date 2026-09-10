import { Text, View } from "react-native";
import { Avatar, AppIcon } from "@/src/ui";
import { PressableScale } from "@/src/ui/PressableScale";
import type { RemoteSessionSearchHit, RemoteSpaceSearchHit, SessionNavigationTarget } from "@/src/data/session-search";
import { useAppTheme, typography } from "@/src/theme";
import { useTranslation } from "@/src/i18n";
import { formatRelativeTime, shortPreview } from "@/src/utils";

type SessionSearchRowProps = {
  hit: RemoteSessionSearchHit;
  onPress: (target?: SessionNavigationTarget) => void;
  showSpace?: boolean;
};

export function SessionSearchRow({ hit, onPress, showSpace = true }: SessionSearchRowProps) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const spaceName = hit.spaceName?.trim() || t("space.fallbackName");
  const target = hit.turnSequence == null && !hit.turnId ? undefined : { ...(hit.turnSequence != null ? { turn: hit.turnSequence } : {}), ...(hit.turnId ? { turnId: hit.turnId } : {}) };
  const content = <>
    {showSpace ? <Avatar name={spaceName} uri={hit.spaceAvatarUrl} size={48} /> : null}
    <View style={{ flex: 1, minWidth: 0, alignSelf: "stretch", justifyContent: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, flex: 1 }]}>{hit.title}</Text>
        <Text style={[typography.micro, { color: theme.colors.textFaint }]}>{formatRelativeTime(hit.updatedAt)}</Text>
      </View>
      <Text numberOfLines={2} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 4 }]}>
        {showSpace ? `${spaceName} · ` : ""}{shortPreview(hit.preview, 84)}
      </Text>
    </View>
    <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} />
  </>;
  const rowStyle = { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, minHeight: 78, paddingHorizontal: 16, paddingVertical: 11, backgroundColor: "transparent" };
  const rowPressedStyle = { backgroundColor: theme.colors.surfacePressed };
  return <PressableScale accessibilityRole="button" accessibilityLabel={t("ui.openNamed", { name: hit.title })} onPress={() => onPress(target)} haptic style={rowStyle} pressedStyle={rowPressedStyle}>{content}</PressableScale>;
}

export function SpaceSearchRow({ hit, onPress }: { hit: RemoteSpaceSearchHit; onPress: () => void }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={t("ui.openNamed", { name: hit.title })}
      onPress={onPress}
      haptic
      style={{ flexDirection: "row", alignItems: "center", gap: 13, minHeight: 84, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}
      pressedStyle={{ backgroundColor: theme.colors.surfacePressed }}
    >
      <Avatar name={hit.title} uri={hit.avatarUrl} size={50} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>{hit.title}</Text>
        <Text numberOfLines={2} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 4 }]}>{hit.description || t("space.matching")}</Text>
        <Text style={[typography.micro, { color: theme.colors.textFaint, marginTop: 5 }]}>{hit.updatedAt ? t("ui.activeAgo", { time: formatRelativeTime(hit.updatedAt) }) : t("space.fallbackName")}</Text>
      </View>
      <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} />
    </PressableScale>
  );
}
