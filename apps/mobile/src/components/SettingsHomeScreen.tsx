import { Link, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCurrentUser } from "@/src/auth/current-user";
import { useProfileSession } from "@/src/auth/profile-session";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { SettingsRow } from "@/src/components/SettingsRow";
import { useDebugUnlock } from "@/src/components/useDebugUnlock";
import { useApp } from "@/src/data/context";
import { settingsMenu } from "@/src/data/settings-navigation";
import { useTranslation } from "@/src/i18n";
import { getInstalledAppVersion } from "@/src/platform/app-updates";
import { useAppTheme, useThemePreference, typography } from "@/src/theme";
import { AppIcon, Avatar, TopBar, PrimaryButton, Screen } from "@/src/ui";

export function SettingsHomeScreen() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { t, preference: language } = useTranslation();
  const appearance = useThemePreference();
  const router = useRouter();
  const { signOut } = useProfileSession();
  const { name, email, avatar } = useCurrentUser();
  const { connectionState, clearCache } = useApp();
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const version = getInstalledAppVersion();
  const openDebug = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    router.push("/debug");
  }, [router]);
  const unlockDebug = useDebugUnlock(openDebug);

  const confirmSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setError(null);
    try {
      try {
        await clearCache();
      } catch {
        setError(t("profile.clearCache.partialError"));
      }
      await signOut();
      setSignOutOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("profile.signOut.error"));
    } finally {
      setSigningOut(false);
    }
  };

  return <Screen>
    <TopBar title={t("settings.title")} onBack={() => router.back()} />
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + theme.spacing.xl }} keyboardShouldPersistTaps="handled">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("settings.section.profile")}
        onPress={() => router.push("/settings/profile")}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: theme.spacing.lg, padding: theme.spacing.lg, marginBottom: theme.spacing.md, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface })}
      >
        <Link.AppleZoomTarget><Avatar name={name} uri={avatar} size={52} online={connectionState === "open"} /></Link.AppleZoomTarget>
        <View style={{ flex: 1, minWidth: 0, gap: theme.spacing.xs }}>
          <Text style={[typography.heading, { color: theme.colors.text }]}>{name}</Text>
          <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{email || t("settings.section.profile")}</Text>
        </View>
        <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} />
      </Pressable>
      <View testID="settings-list">
        {settingsMenu.map((item) => <SettingsRow
          key={item.href}
          icon={item.icon}
          title={t(item.labelKey)}
          value={item.href === "/appearance" ? t(`appearance.theme.${appearance}`) : item.href === "/language" ? t(language === "system" ? "language.option.system" : language === "en" ? "language.device.english" : "language.device.chinese") : undefined}
          onPress={() => router.push(item.href)}
        />)}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("common.signOut")}
        disabled={signingOut}
        onPress={() => { setError(null); setSignOutOpen(true); }}
        style={({ pressed }) => ({ marginTop: theme.spacing.xl, minHeight: 48, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.dangerSoft : "transparent" })}
      ><Text style={[typography.bodyMedium, { color: theme.colors.danger }]}>{signingOut ? t("profile.signingOut") : t("common.signOut")}</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t("profile.version")} onPress={unlockDebug} style={{ minHeight: 44, alignItems: "center", justifyContent: "center" }}>
        <Text style={[typography.micro, { color: theme.colors.textFaint, textAlign: "center" }]}>Cohub Mobile · {version}</Text>
      </Pressable>
    </ScrollView>
    <AdaptiveSheet
      visible={signOutOpen}
      title={t("profile.signOut.title")}
      subtitle={t("profile.signOut.subtitle")}
      onClose={() => { if (!signingOut) setSignOutOpen(false); }}
      dismissible={!signingOut}
      scrollable={false}
      testID="sign-out-sheet"
      footer={<PrimaryButton label={t("common.signOut")} icon="arrow-right" tone="danger" loading={signingOut} onPress={() => void confirmSignOut()} />}
    >
      <Text style={[typography.body, { color: theme.colors.textSecondary }]}>{t("profile.signOut.body")}</Text>
      {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: theme.colors.danger, marginTop: theme.spacing.md }]}>{error}</Text> : null}
    </AdaptiveSheet>
  </Screen>;
}
