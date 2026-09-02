import { Pressable, Text, View } from "react-native";
import { Avatar, AppIcon } from "@/src/ui";
import type { RemoteSessionSearchHit, RemoteSpaceSearchHit, SessionNavigationTarget } from "@/src/data/session-search";
import { useAppTheme, typography } from "@/src/theme";
import { formatRelativeTime, shortPreview } from "@/src/utils";

export function SessionSearchRow({ hit, onPress }: { hit: RemoteSessionSearchHit; onPress: (target?: SessionNavigationTarget) => void }) {
  const theme = useAppTheme();
  const spaceName = hit.spaceName?.trim() || "Space";
  const target = hit.turnSequence == null && !hit.turnId ? undefined : { ...(hit.turnSequence != null ? { turn: hit.turnSequence } : {}), ...(hit.turnId ? { turnId: hit.turnId } : {}) };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${hit.title}`}
      onPress={() => onPress(target)}
      android_ripple={{ color: theme.colors.pressOverlay }}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 78, paddingHorizontal: 16, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}
    >
      <Avatar name={spaceName} uri={hit.spaceAvatarUrl} size={48} />
      <View style={{ flex: 1, minWidth: 0, alignSelf: "stretch", justifyContent: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, flex: 1 }]}>{hit.title}</Text>
          <Text style={[typography.micro, { color: theme.colors.textFaint }]}>{formatRelativeTime(hit.updatedAt)}</Text>
        </View>
        <Text numberOfLines={2} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 4 }]}>
          {spaceName} · {shortPreview(hit.preview, 84)}
        </Text>
      </View>
      <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} />
    </Pressable>
  );
}

export function SpaceSearchRow({ hit, onPress }: { hit: RemoteSpaceSearchHit; onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${hit.title}`}
      onPress={onPress}
      android_ripple={{ color: theme.colors.pressOverlay }}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 13, minHeight: 84, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}
    >
      <Avatar name={hit.title} uri={hit.avatarUrl} size={50} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>{hit.title}</Text>
        <Text numberOfLines={2} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 4 }]}>{hit.description || "Matching Space"}</Text>
        <Text style={[typography.micro, { color: theme.colors.textFaint, marginTop: 5 }]}>{hit.updatedAt ? `Active ${formatRelativeTime(hit.updatedAt)}` : "Space"}</Text>
      </View>
      <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} />
    </Pressable>
  );
}
