import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { loadBrowserPreference, saveBrowserPreference, useBrowserPreference, type BrowserPreference } from "@/src/data/browser-preference";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, IconButton, SectionHeader } from "@/src/ui";

export function BrowserSettings() {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const current = useBrowserPreference();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const select = async (next: BrowserPreference) => {
    if (saving || (current.loaded && next === current.preference)) return;
    setSaving(true);
    setSaveError(false);
    try {
      await saveBrowserPreference(next);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };
  return <View testID="browser-settings">
    <SectionHeader title={t("settings.browser.section")} />
    {!current.loaded && !current.error ? <ActivityIndicator color={theme.colors.accent} style={{ padding: theme.spacing.xl }} /> : <View accessibilityRole="radiogroup">
      {(["system", "in-app"] as const).map((option) => {
        const selected = current.loaded && current.preference === option;
        const title = t(option === "system" ? "settings.browser.system" : "settings.browser.inApp");
        return <Pressable
          key={option}
          testID={`browser-option-${option}`}
          accessibilityRole="radio"
          accessibilityLabel={title}
          accessibilityState={{ checked: selected, selected, disabled: saving }}
          disabled={saving}
          onPress={() => void select(option)}
          style={({ pressed }) => ({ minHeight: 56, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md, flexDirection: "row", alignItems: "center", gap: theme.spacing.md, borderBottomWidth: 1, borderBottomColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface, opacity: saving ? 0.6 : 1 })}
        >
          <AppIcon name={option === "system" ? "external-link" : "globe"} size={20} color={theme.colors.textMuted} />
          <Text style={[typography.body, { flex: 1, color: selected ? theme.colors.accent : theme.colors.text }]}>{title}</Text>
          <View style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center" }}>
            {selected ? <AppIcon name="check" size={18} color={theme.colors.accent} /> : null}
          </View>
        </Pressable>;
      })}
    </View>}
    {current.error || saveError ? <View style={{ padding: theme.spacing.lg, gap: theme.spacing.sm, flexDirection: "row", alignItems: "center" }}>
      <Text accessibilityRole="alert" style={[typography.caption, { color: theme.colors.danger, flex: 1 }]}>{t(saveError ? "settings.browser.saveFailed" : "settings.browser.loadFailed")}</Text>
      {current.error ? <IconButton name="refresh" label={t("common.retry")} disabled={saving} onPress={() => void loadBrowserPreference().catch(() => undefined)} /> : null}
    </View> : null}
  </View>;
}
