import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import type { SpaceMentionMenuState } from "@/src/data/use-composer-mentions";
import type { SpaceMentionSuggestion } from "@/src/data/space-mentions";
import { useTranslation } from "@/src/i18n";
import { typography, useAppTheme } from "@/src/theme";
import { Avatar, IconButton } from "@/src/ui";
import { displaySpaceName } from "@/src/utils";

/** Non-modal so the composer keeps focus and the keyboard while the query is typed. */
export function SpaceMentionMenu({ menu, onSelect, onDismiss, style }: { menu: SpaceMentionMenuState; onSelect: (item: SpaceMentionSuggestion) => void; onDismiss: () => void; style?: ViewStyle }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const status = !menu.query.trim()
    ? t("mentions.hint")
    : menu.remoteFailed
      ? t("mentions.localOnly")
      : menu.loading
        ? t("mentions.searching")
        : t("mentions.count", { count: menu.items.length });
  return <View testID="space-mention-menu" accessibilityLabel={t("mentions.title")} style={[styles.panel, { backgroundColor: theme.colors.surface, borderColor: theme.colors.borderStrong, shadowColor: theme.colors.shadow }, style]}>
    <View style={styles.header}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{t("mentions.title")}</Text>
        <Text numberOfLines={1} style={[typography.micro, { color: menu.remoteFailed ? theme.colors.danger : theme.colors.textMuted }]}>{status}</Text>
      </View>
      <IconButton name="x" label={t("mentions.dismiss")} size={40} onPress={onDismiss} />
    </View>
    {menu.items.length === 0 ? <View style={styles.empty}>
      {menu.loading ? <ActivityIndicator accessibilityLabel={t("mentions.searching")} size="small" color={theme.colors.accent} /> : <>
        <Text style={[typography.bodyMedium, { color: theme.colors.text, textAlign: "center" }]}>{t("mentions.empty")}</Text>
        <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 3, textAlign: "center" }]}>{t("mentions.emptyHint")}</Text>
      </>}
    </View> : <ScrollView style={styles.list} keyboardShouldPersistTaps="always" keyboardDismissMode="none">
      {menu.items.map((item) => {
        const name = item.name ?? displaySpaceName(null);
        return <Pressable key={item.spaceId} accessibilityRole="button" accessibilityLabel={t("mentions.select", { name })} onPress={() => onSelect(item)} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" }]}>
          <Avatar name={name} uri={item.avatarUrl} size={34} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>{name}</Text>
            {item.description ? <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 1 }]}>{item.description}</Text> : null}
          </View>
        </Pressable>;
      })}
    </ScrollView>}
  </View>;
}

const styles = StyleSheet.create({
  panel: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, borderCurve: "continuous", overflow: "hidden", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 12, elevation: 8 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 14, paddingRight: 4, paddingVertical: 4 },
  list: { maxHeight: 232, flexGrow: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 11, minHeight: 52, paddingHorizontal: 12, paddingVertical: 6 },
  empty: { minHeight: 88, alignItems: "center", justifyContent: "center", paddingHorizontal: 20, paddingBottom: 12 },
});
