import { Link, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useCallback, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCurrentUser } from "@/src/auth/current-user";
import { useProfileSession } from "@/src/auth/profile-session";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { useDebugUnlock } from "@/src/components/useDebugUnlock";
import { CACHE_RETENTION_OPTIONS, setCacheRetention, useCacheRetention, type CacheRetention } from "@/src/data/cache-retention";
import { useApp } from "@/src/data/context";
import { useTranslation, type Translate } from "@/src/i18n";
import { getInstalledAppVersion } from "@/src/platform/app-updates";
import { useAppTheme, typography } from "@/src/theme";
import {
  AppIcon,
  Avatar,
  DataError,
  TopBar,
  PrimaryButton,
  Screen,
  SectionHeader,
} from "@/src/ui";

type ProfileSheet = "clear-cache" | "sign-out" | "cache-retention" | null;

export default function ProfileScreen() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const router = useRouter();
  const { signOut } = useProfileSession();
  const { name, email, avatar } = useCurrentUser();
  const { state, connectionState, clearCache, applyCacheRetention, refreshHome } = useApp();
  const dataError = state.error ?? state.spacesError ?? state.sessionsError;
  const [sheet, setSheet] = useState<ProfileSheet>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const retention = useCacheRetention();

  const version = getInstalledAppVersion();
  const openDebug = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    router.push("/debug");
  }, [router]);
  const unlockDebug = useDebugUnlock(openDebug);

  const openSheet = (nextSheet: Exclude<ProfileSheet, null>) => {
    setSheetError(null);
    setSheet(nextSheet);
  };

  const closeSheet = () => {
    if (!clearingCache && !signingOut) setSheet(null);
  };

  const confirmClearCache = async () => {
    if (clearingCache) return;
    setClearingCache(true);
    setSheetError(null);
    try {
      await clearCache();
      setSheet(null);
    } catch (error) {
      setSheetError(error instanceof Error ? error.message : t("profile.clearCache.error"));
    } finally {
      setClearingCache(false);
    }
  };

  const confirmSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSheetError(null);
    try {
      try {
        await clearCache();
      } catch {
        setSheetError(t("profile.clearCache.partialError"));
      }
      await signOut();
      setSheet(null);
    } catch (error) {
      setSheetError(error instanceof Error ? error.message : t("profile.signOut.error"));
    } finally {
      setSigningOut(false);
    }
  };

  const selectRetention = async (next: CacheRetention) => {
    if (next === retention) return;
    setSheetError(null);
    try {
      await setCacheRetention(next);
      await applyCacheRetention();
    } catch (error) {
      setSheetError(error instanceof Error ? error.message : t("profile.cacheRetention.error"));
    }
  };

  return (
    <Screen>
      <TopBar title={t("route.profile")} onBack={() => router.back()} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 28 }} keyboardShouldPersistTaps="handled">
      <View style={styles.profileHeader}>
        <Link.AppleZoomTarget>
          <Avatar name={name} uri={avatar} size={76} online={connectionState === "open"} />
        </Link.AppleZoomTarget>
        <Text style={[typography.title, { color: theme.colors.text, marginTop: 12 }]}>
          {name}
        </Text>
        {email ? (
          <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 4 }]}>
            {email}
          </Text>
        ) : null}
      </View>
      {dataError ? <DataError message={dataError} onRetry={() => void refreshHome()} /> : null}

      <SectionHeader title={t("profile.section.app")} />
      <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        <SettingRow
          icon="settings"
          title={t("profile.settings.title")}
          detail={t("profile.settings.detail")}
          onPress={() => router.push("/settings")}
          trailing={<AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} />}
        />
        <SettingRow
          icon="palette"
          title={t("profile.appearance.title")}
          detail={t("profile.appearance.detail")}
          onPress={() => router.push("/appearance")}
          trailing={<AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} />}
        />
        <SettingRow
          icon="globe"
          title={t("profile.language.title")}
          detail={t("profile.language.detail")}
          onPress={() => router.push("/language")}
          trailing={<AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} />}
        />
        <SettingRow
          icon="info"
          title={t("profile.about.title")}
          detail={t("profile.about.detail", { version })}
          onPress={() => router.push("/about")}
          trailing={<AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} />}
        />
      </View>

      <SectionHeader title={t("profile.section.data")} />
      <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        <SettingRow icon="database" title={t("profile.data.spaces")} detail={t("ui.available.offline", { count: state.spaces.length })} />
        <SettingRow icon="messages" title={t("profile.data.chats")} detail={t("ui.recent.threads", { count: state.sessions.length })} />
        <SettingRow
          icon="clock"
          title={t("profile.data.retention")}
          detail={retentionLabel(retention, t)}
          onPress={() => openSheet("cache-retention")}
          trailing={<AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} />}
        />
        <SettingRow
          icon="trash"
          title={t("profile.data.clearCache")}
          detail={t("profile.data.clearCacheDetail")}
          onPress={() => openSheet("clear-cache")}
          trailing={<AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} />}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("common.signOut")}
        disabled={signingOut}
        onPress={() => openSheet("sign-out")}
        style={({ pressed }) => ({
          marginHorizontal: 16,
          marginTop: 26,
          minHeight: 48,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: pressed ? theme.colors.dangerSoft : "transparent",
          opacity: signingOut ? 0.55 : 1,
        })}
      >
        <Text style={[typography.bodyMedium, { color: theme.colors.danger }]}>
          {signingOut ? t("profile.signingOut") : t("common.signOut")}
        </Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t("profile.version")} onPress={unlockDebug} hitSlop={10}>
        <Text style={[typography.micro, { color: theme.colors.textFaint, textAlign: "center", marginTop: 22, marginBottom: 8 }]}>
          Cohub Mobile · {version}
        </Text>
      </Pressable>
      </ScrollView>

      <AdaptiveSheet
        visible={sheet === "clear-cache"}
        title={t("profile.clearCache.title")}
        subtitle={t("profile.clearCache.subtitle")}
        onClose={closeSheet}
        dismissible={!clearingCache}
        scrollable={false}
        testID="clear-cache-sheet"
        footer={
          <SheetFooter>
            <PrimaryButton
              label={t("profile.clearCache.action")}
              icon="trash"
              tone="danger"
              loading={clearingCache}
              onPress={() => void confirmClearCache()}
              style={{ minHeight: 46, paddingHorizontal: 16 }}
            />
          </SheetFooter>
        }
      >
        <Text style={[typography.body, { color: theme.colors.textSecondary }]}>{t("profile.clearCache.body")}</Text>
        {sheetError ? <SheetError message={sheetError} /> : null}
      </AdaptiveSheet>

      <AdaptiveSheet
        visible={sheet === "sign-out"}
        title={t("profile.signOut.title")}
        subtitle={t("profile.signOut.subtitle")}
        onClose={closeSheet}
        dismissible={!signingOut}
        scrollable={false}
        testID="sign-out-sheet"
        footer={
          <SheetFooter>
            <PrimaryButton
              label={t("common.signOut")}
              icon="arrow-right"
              tone="danger"
              loading={signingOut}
              onPress={() => void confirmSignOut()}
              style={{ minHeight: 46, paddingHorizontal: 16 }}
            />
          </SheetFooter>
        }
      >
        <Text style={[typography.body, { color: theme.colors.textSecondary }]}>{t("profile.signOut.body")}</Text>
        {sheetError ? <SheetError message={sheetError} /> : null}
      </AdaptiveSheet>

      <AdaptiveSheet
        visible={sheet === "cache-retention"}
        title={t("profile.cacheRetention.title")}
        subtitle={t("profile.cacheRetention.subtitle")}
        onClose={closeSheet}
        scrollable={false}
        testID="cache-retention-sheet"
      >
        <Text style={[typography.body, { color: theme.colors.textSecondary }]}>{t("profile.cacheRetention.body")}</Text>
        <View style={{ gap: 8, marginTop: 14 }}>
          {CACHE_RETENTION_OPTIONS.map((option) => {
            const selected = retention === option;
            const label = retentionLabel(option, t);
            return (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityLabel={label}
                accessibilityState={{ selected, checked: selected }}
                onPress={() => void selectRetention(option)}
                style={({ pressed }) => [styles.retentionOption, { borderColor: selected ? theme.colors.accentBorder : theme.colors.border, backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : "transparent" }]}
              >
                <Text style={[typography.bodyMedium, { color: selected ? theme.colors.accent : theme.colors.text, flex: 1 }]}>{label}</Text>
                {selected ? <AppIcon name="check" size={17} color={theme.colors.accent} /> : null}
              </Pressable>
            );
          })}
        </View>
        {sheetError ? <SheetError message={sheetError} /> : null}
      </AdaptiveSheet>
    </Screen>
  );
}

function retentionLabel(option: CacheRetention, t: Translate) {
  if (option === "1d") return t("profile.cacheRetention.option.oneDay");
  if (option === "forever") return t("profile.cacheRetention.option.forever");
  return t("profile.cacheRetention.option.days", { days: option === "7d" ? 7 : 30 });
}

function SheetFooter({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10 }}>{children}</View>;
}

function SheetError({ message }: { message: string }) {
  const theme = useAppTheme();
  return <Text style={[typography.caption, { color: theme.colors.danger, marginTop: 12 }]}>{message}</Text>;
}

function SettingRow({
  icon,
  title,
  detail,
  trailing,
  onPress,
}: {
  icon: React.ComponentProps<typeof AppIcon>["name"];
  title: string;
  detail: string;
  trailing?: ReactNode;
  onPress?: () => void;
}) {
  const theme = useAppTheme();
  const content = (
    <View style={[styles.settingRow, { borderBottomColor: theme.colors.border }]}>
      <View style={[styles.settingIcon, { backgroundColor: theme.colors.surfaceRaised }]}>
        <AppIcon name={icon} size={16} color={theme.colors.textMuted} />
      </View>
      <View style={styles.settingText}>
        <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{title}</Text>
        <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>
          {detail}
        </Text>
      </View>
      {trailing}
    </View>
  );
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
     
      style={({ pressed }) => ({ backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}
    >
      {content}
    </Pressable>
  ) : (
    content
  );
}

const styles = {
  profileHeader: {
    alignItems: "center" as const,
    paddingTop: 22,
    paddingBottom: 18,
  },
  group: {
    marginHorizontal: 16,
    borderWidth: 1,
    borderRadius: 14,
    overflow: "hidden" as const,
  },
  settingRow: {
    minHeight: 62,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 11,
    paddingHorizontal: 13,
    borderBottomWidth: 1,
  },
  settingIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  settingText: {
    flex: 1,
    minWidth: 0,
  },
  retentionOption: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 11,
    paddingHorizontal: 13,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
  },
} satisfies Record<string, object>;
