import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useCallback, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useCurrentUser } from "@/src/auth/current-user";
import { useProfileSession } from "@/src/auth/profile-session";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { useDebugUnlock } from "@/src/components/useDebugUnlock";
import { useApp } from "@/src/data/context";
import { getInstalledAppVersion } from "@/src/platform/app-updates";
import { useAppTheme, typography } from "@/src/theme";
import {
  AppIcon,
  Avatar,
  DataError,
  PrimaryButton,
  Screen,
  SectionHeader,
} from "@/src/ui";

type ProfileSheet = "clear-cache" | "sign-out" | null;

export default function ProfileScreen() {
  const theme = useAppTheme();
  const router = useRouter();
  const { signOut } = useProfileSession();
  const { name, email, avatar } = useCurrentUser();
  const { state, connectionState, clearCache, refreshHome } = useApp();
  const dataError = state.error ?? state.spacesError ?? state.sessionsError;
  const [sheet, setSheet] = useState<ProfileSheet>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

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
      setSheetError(error instanceof Error ? error.message : "Unable to clear local cache.");
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
        setSheetError("Local cache could not be cleared. Signing out anyway.");
      }
      await signOut();
      setSheet(null);
    } catch (error) {
      setSheetError(error instanceof Error ? error.message : "Unable to sign out.");
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <Screen scroll>
      <View style={styles.profileHeader}>
        <Avatar name={name} uri={avatar} size={76} online={connectionState === "open"} />
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

      <SectionHeader title="App" />
      <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        <SettingRow
          icon="settings"
          title="Settings"
          detail="Account and notification preferences"
          onPress={() => router.push("/settings")}
          trailing={<AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} />}
        />
        <SettingRow
          icon="palette"
          title="Appearance"
          detail="Theme and display"
          onPress={() => router.push("/appearance")}
          trailing={<AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} />}
        />
        <SettingRow
          icon="info"
          title="About"
          detail={`Cohub Mobile · ${version}`}
          onPress={() => router.push("/about")}
          trailing={<AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} />}
        />
      </View>

      <SectionHeader title="Data" />
      <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        <SettingRow icon="database" title="Cached Spaces" detail={`${state.spaces.length} available offline`} />
        <SettingRow icon="messages" title="Cached Chats" detail={`${state.sessions.length} recent threads`} />
        <SettingRow
          icon="trash"
          title="Clear local cache"
          detail="Remove cached work from this device"
          onPress={() => openSheet("clear-cache")}
          trailing={<AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} />}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign out"
        disabled={signingOut}
        onPress={() => openSheet("sign-out")}
        style={({ pressed }) => ({
          marginHorizontal: 16,
          marginTop: 26,
          minHeight: 48,
          borderRadius: 13,
          borderWidth: 1,
          borderColor: theme.colors.danger,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: pressed ? theme.colors.dangerSoft : "transparent",
          opacity: signingOut ? 0.55 : 1,
        })}
      >
        <Text style={[typography.bodyMedium, { color: theme.colors.danger }]}>
          {signingOut ? "Signing out…" : "Sign out"}
        </Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="App version" onPress={unlockDebug} hitSlop={10}>
        <Text style={[typography.micro, { color: theme.colors.textFaint, textAlign: "center", marginTop: 22, marginBottom: 8 }]}>
          Cohub Mobile · {version}
        </Text>
      </Pressable>

      <AdaptiveSheet
        visible={sheet === "clear-cache"}
        title="Clear local cache?"
        subtitle="This only removes local copies. Your Spaces remain on Cohub."
        onClose={closeSheet}
        dismissible={!clearingCache}
        scrollable={false}
        testID="clear-cache-sheet"
        footer={
          <SheetFooter>
            <Pressable disabled={clearingCache} onPress={closeSheet} style={styles.cancelButton}>
              <Text style={[typography.bodyMedium, { color: theme.colors.textSecondary }]}>Cancel</Text>
            </Pressable>
            <PrimaryButton
              label="Clear cache"
              icon="trash"
              tone="danger"
              loading={clearingCache}
              onPress={() => void confirmClearCache()}
              style={{ minHeight: 46, paddingHorizontal: 16 }}
            />
          </SheetFooter>
        }
      >
        <Text style={[typography.body, { color: theme.colors.textSecondary }]}>Cached Spaces and Chat messages will be removed from this device.</Text>
        {sheetError ? <SheetError message={sheetError} /> : null}
      </AdaptiveSheet>

      <AdaptiveSheet
        visible={sheet === "sign-out"}
        title="Sign out of Cohub?"
        subtitle="Your cached work on this device will be cleared."
        onClose={closeSheet}
        dismissible={!signingOut}
        scrollable={false}
        testID="sign-out-sheet"
        footer={
          <SheetFooter>
            <Pressable disabled={signingOut} onPress={closeSheet} style={styles.cancelButton}>
              <Text style={[typography.bodyMedium, { color: theme.colors.textSecondary }]}>Cancel</Text>
            </Pressable>
            <PrimaryButton
              label="Sign out"
              icon="arrow-right"
              tone="danger"
              loading={signingOut}
              onPress={() => void confirmSignOut()}
              style={{ minHeight: 46, paddingHorizontal: 16 }}
            />
          </SheetFooter>
        }
      >
        <Text style={[typography.body, { color: theme.colors.textSecondary }]}>You can sign in again later. Work stored in your Spaces will not be changed.</Text>
        {sheetError ? <SheetError message={sheetError} /> : null}
      </AdaptiveSheet>
    </Screen>
  );
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
  cancelButton: {
    minHeight: 46,
    paddingHorizontal: 15,
    justifyContent: "center" as const,
  },
} satisfies Record<string, object>;
