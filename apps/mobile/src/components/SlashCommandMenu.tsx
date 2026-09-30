import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { slashCommandLabel, type SlashCommandItem } from "@/src/data/slash-commands";
import type { SlashCommandMenuState } from "@/src/data/use-composer-slash";
import { useTranslation } from "@/src/i18n";
import { typography, useAppTheme } from "@/src/theme";
import { IconButton } from "@/src/ui";

/** Non-modal so the composer keeps focus and the keyboard while the query is typed. */
export function SlashCommandMenu({ menu, onSelect, onDismiss, style }: { menu: SlashCommandMenuState; onSelect: (item: SlashCommandItem) => void; onDismiss: () => void; style?: ViewStyle }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const status = menu.query.trim()
    ? t("slash.count", { count: menu.items.length })
    : menu.failed
      ? t("slash.unavailable")
      : menu.loading
        ? t("slash.loading")
        : t("slash.hint");
  return <View testID="slash-command-menu" accessibilityLabel={t("slash.title")} style={[styles.panel, { backgroundColor: theme.colors.surface, borderColor: theme.colors.borderStrong, shadowColor: theme.colors.shadow }, style]}>
    <View style={styles.header}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{t("slash.title")}</Text>
        <Text numberOfLines={1} style={[typography.micro, { color: menu.failed ? theme.colors.danger : theme.colors.textMuted }]}>{status}</Text>
      </View>
      <IconButton name="x" label={t("slash.dismiss")} size={40} onPress={onDismiss} />
    </View>
    {menu.items.length === 0 ? <View style={styles.empty}>
      {menu.loading ? <ActivityIndicator accessibilityLabel={t("slash.loading")} size="small" color={theme.colors.accent} /> : <>
        <Text style={[typography.bodyMedium, { color: theme.colors.text, textAlign: "center" }]}>{t("slash.empty")}</Text>
        <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 3, textAlign: "center" }]}>{t("slash.emptyHint")}</Text>
      </>}
    </View> : <ScrollView style={styles.list} keyboardShouldPersistTaps="always" keyboardDismissMode="none">
      {menu.items.map((item) => {
        const label = slashCommandLabel(item);
        return <Pressable key={`${item.kind}:${item.name}`} accessibilityRole="button" accessibilityLabel={t("slash.select", { name: label })} onPress={() => onSelect(item)} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" }]}>
          <View style={[styles.badge, { backgroundColor: theme.colors.surfacePressed, borderColor: theme.colors.border }]}>
            <Text style={[typography.bodyMedium, { color: theme.colors.textMuted }]}>/</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>/{label}</Text>
            <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 1 }]}>{item.argumentHint ?? item.description}</Text>
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
  badge: { width: 34, height: 34, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  empty: { minHeight: 88, alignItems: "center", justifyContent: "center", paddingHorizontal: 20, paddingBottom: 12 },
});
