import { useState } from "react";
import { ActivityIndicator, Text, TextInput, View } from "react-native";
import { useToast } from "@/src/components/Toast";
import { loadSessionFilterMinutes, saveSessionFilterMinutes, useSessionFilterPreference } from "@/src/data/session-filter-preference";
import { MAX_SESSION_FILTER_MINUTES, parseSessionFilterMinutes } from "@/src/data/session-status";
import { useTranslation } from "@/src/i18n";
import { typography, useAppTheme } from "@/src/theme";
import { IconButton, PrimaryButton } from "@/src/ui";

export function ChatFilterSettings() {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const preference = useSessionFilterPreference();
  return <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
    {preference.error ? <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
      <Text style={[typography.caption, { color: theme.colors.danger, flex: 1 }]}>{preference.error}</Text>
      <IconButton name="refresh" label={t("common.retry")} onPress={() => void loadSessionFilterMinutes().catch(() => undefined)} />
    </View> : null}
    {!preference.loaded && !preference.error ? <ActivityIndicator color={theme.colors.accent} /> : <ChatFilterForm key={preference.minutes} minutes={preference.minutes} />}
  </View>;
}

function ChatFilterForm({ minutes }: { minutes: number }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const toast = useToast();
  const [input, setInput] = useState(String(minutes));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    let next: number;
    try {
      next = parseSessionFilterMinutes(input);
    } catch {
      setError(t("settings.chats.invalid", { max: MAX_SESSION_FILTER_MINUTES }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveSessionFilterMinutes(next);
      toast({ title: t("settings.chats.saved") });
    } catch {
      setError(t("settings.chats.saveFailed"));
    } finally {
      setSaving(false);
    }
  };
  return <View style={{ gap: theme.spacing.md }}>
    <Text style={[typography.heading, { color: theme.colors.text }]}>{t("settings.chats.window")}</Text>
    <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{t("chats.filter.running")} / {t("chats.filter.completed")}</Text>
    <TextInput
      testID="chat-filter-minutes"
      accessibilityLabel={t("settings.chats.window")}
      keyboardType="number-pad"
      value={input}
      onChangeText={setInput}
      editable={!saving}
      maxLength={4}
      selectTextOnFocus
      style={[typography.body, { minHeight: 48, color: theme.colors.text, backgroundColor: theme.colors.surface, borderColor: error ? theme.colors.danger : theme.colors.border, borderWidth: 1, borderRadius: theme.radius.sm, paddingHorizontal: theme.spacing.md }]}
    />
    <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{t("settings.chats.range", { max: MAX_SESSION_FILTER_MINUTES })}</Text>
    {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: theme.colors.danger }]}>{error}</Text> : null}
    <PrimaryButton label={t("common.save")} icon="check" loading={saving} disabled={saving} onPress={() => void save()} style={{ alignSelf: "flex-start" }} />
  </View>;
}
