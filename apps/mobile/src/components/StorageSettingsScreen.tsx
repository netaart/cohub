import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { SettingsRow } from "@/src/components/SettingsRow";
import { CACHE_RETENTION_OPTIONS, setCacheRetention, useCacheRetention, type CacheRetention } from "@/src/data/cache-retention";
import { useApp } from "@/src/data/context";
import { useTranslation, type Translate } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, TopBar, PrimaryButton, Screen } from "@/src/ui";

export function StorageSettingsScreen() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const router = useRouter();
  const { state, clearCache, applyCacheRetention } = useApp();
  const retention = useCacheRetention();
  const [sheet, setSheet] = useState<"clear-cache" | "cache-retention" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openSheet = (next: "clear-cache" | "cache-retention") => { setError(null); setSheet(next); };
  const confirmClearCache = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await clearCache();
      setSheet(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("profile.clearCache.error"));
    } finally {
      setBusy(false);
    }
  };
  const selectRetention = async (next: CacheRetention) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setCacheRetention(next);
      await applyCacheRetention();
      setSheet(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("profile.cacheRetention.error"));
    } finally {
      setBusy(false);
    }
  };
  return <Screen>
    <TopBar title={t("settings.storage.title")} onBack={() => router.back()} />
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + theme.spacing.xl }}>
      <SettingsRow icon="database" title={t("profile.data.spaces")} value={String(state.spaces.length)} />
      <SettingsRow icon="messages" title={t("profile.data.chats")} value={String(state.sessions.length)} />
      <SettingsRow icon="clock" title={t("profile.data.retention")} value={retentionLabel(retention, t)} onPress={() => openSheet("cache-retention")} />
      <SettingsRow icon="trash" title={t("profile.data.clearCache")} onPress={() => openSheet("clear-cache")} danger />
    </ScrollView>
    <AdaptiveSheet
      visible={sheet !== null}
      title={t(sheet === "clear-cache" ? "profile.clearCache.title" : "profile.cacheRetention.title")}
      onClose={() => { if (!busy) setSheet(null); }}
      dismissible={!busy}
      scrollable={false}
      testID={sheet === "clear-cache" ? "clear-cache-sheet" : "cache-retention-sheet"}
      footer={sheet === "clear-cache" ? <PrimaryButton label={t("profile.clearCache.action")} icon="trash" tone="danger" loading={busy} onPress={() => void confirmClearCache()} /> : undefined}
    >
      {sheet === "clear-cache" ? <Text style={[typography.body, { color: theme.colors.textSecondary }]}>{t("profile.clearCache.body")}</Text> : <View>
        {CACHE_RETENTION_OPTIONS.map((option) => <Pressable
          key={option}
          accessibilityRole="radio"
          accessibilityState={{ checked: retention === option, disabled: busy }}
          disabled={busy}
          onPress={() => void selectRetention(option)}
          style={({ pressed }) => ({ minHeight: 52, flexDirection: "row", alignItems: "center", gap: theme.spacing.md, padding: theme.spacing.md, borderBottomWidth: 1, borderBottomColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}
        >
          <Text style={[typography.body, { flex: 1, color: theme.colors.text }]}>{retentionLabel(option, t)}</Text>
          {retention === option ? <AppIcon name="check" size={18} color={theme.colors.accent} /> : null}
        </Pressable>)}
      </View>}
      {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: theme.colors.danger, marginTop: theme.spacing.md }]}>{error}</Text> : null}
    </AdaptiveSheet>
  </Screen>;
}

function retentionLabel(option: CacheRetention, t: Translate): string {
  if (option === "1d") return t("profile.cacheRetention.option.oneDay");
  if (option === "forever") return t("profile.cacheRetention.option.forever");
  return t("profile.cacheRetention.option.days", { days: option === "7d" ? 7 : 30 });
}
