import { useProfileSession } from "@/src/auth/profile-session";
import * as Application from "expo-application";
import { useEffect, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { useApp } from "@/src/data/context";
import { registerForPushNotifications } from "@/src/platform/notifications";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, Avatar, BrandMark, IconButton, Screen, SectionHeader, StatusPill, TopBar } from "@/src/ui";

export default function ProfileScreen() {
  const theme = useAppTheme();
  const { getClaims, signOut } = useProfileSession();
  const { state, connectionState, clearCache, installationId } = useApp();
  const [profile, setProfile] = useState<{ name: string; email: string | null; avatar: string | null }>({ name: "Cohub user", email: null, avatar: null });
  const [notificationState, setNotificationState] = useState<"unknown" | "enabled" | "denied">("unknown");
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let active = true;
    void getClaims().then((claims) => {
      if (!active) return;
      const name = typeof claims.name === "string" && claims.name.trim() ? claims.name : typeof claims.username === "string" && claims.username.trim() ? claims.username : "Cohub user";
      setProfile({ name, email: typeof claims.email === "string" ? claims.email : null, avatar: typeof claims.picture === "string" ? claims.picture : null });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [getClaims]);

  const enableNotifications = async () => {
    try {
      const registration = await registerForPushNotifications();
      setNotificationState(registration ? "enabled" : "denied");
      if (!registration) Alert.alert("Notifications are off", "Allow notifications in system settings to receive Agent updates.");
    } catch (error) {
      Alert.alert("Notifications unavailable", error instanceof Error ? error.message : "Unable to enable notifications.");
    }
  };

  const handleSignOut = () => {
    Alert.alert("Sign out of Cohub?", "Cached work on this device will be cleared.", [{ text: "Cancel", style: "cancel" }, { text: "Sign out", style: "destructive", onPress: () => { void (async () => { setSigningOut(true); await clearCache().catch(() => undefined); await signOut().catch(() => undefined); setSigningOut(false); })(); } }]);
  };

  return <Screen scroll>
    <TopBar title="Profile" subtitle="Account and device" left={<BrandMark size={36} />} right={<IconButton name="settings-outline" label="Settings" size={38} onPress={() => Alert.alert("Settings", "More account settings will be available here.")} />} />
    <View style={{ alignItems: "center", paddingTop: 28, paddingBottom: 22 }}><Avatar name={profile.name} uri={profile.avatar} size={76} online={connectionState === "open"} /><Text style={[typography.title, { color: theme.colors.text, marginTop: 13 }]}>{profile.name}</Text>{profile.email ? <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 4 }]}>{profile.email}</Text> : null}</View>
    <SectionHeader title="Device" />
    <View style={{ marginHorizontal: 16, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 14, backgroundColor: theme.colors.surface, overflow: "hidden" }}>
      <SettingRow icon="wifi-outline" title="Connection" detail={connectionState === "open" ? "Connected to Cohub" : connectionState} trailing={<StatusPill label={connectionState === "open" ? "Online" : "Offline"} tone={connectionState === "open" ? "success" : "neutral"} />} />
      <SettingRow icon="notifications-outline" title="Agent notifications" detail={notificationState === "enabled" ? "Permission enabled" : "Get notified when work finishes"} onPress={enableNotifications} trailing={<AppIcon name="chevron-forward" size={17} color={theme.colors.textFaint} />} />
      <SettingRow icon="finger-print-outline" title="Installation" detail={installationId ? `${installationId.slice(0, 8)}…` : "Preparing device identity"} />
    </View>
    <SectionHeader title="Data" />
    <View style={{ marginHorizontal: 16, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 14, backgroundColor: theme.colors.surface, overflow: "hidden" }}>
      <SettingRow icon="server-outline" title="Cached Spaces" detail={`${state.spaces.length} available offline`} />
      <SettingRow icon="chatbubbles-outline" title="Cached Chats" detail={`${state.sessions.length} recent threads`} />
      <SettingRow icon="trash-outline" title="Clear local cache" detail="Remove cached work from this device" onPress={() => Alert.alert("Clear cache?", "This only removes local copies. Your Spaces remain on Cohub.", [{ text: "Cancel", style: "cancel" }, { text: "Clear", style: "destructive", onPress: () => void clearCache() }])} trailing={<AppIcon name="chevron-forward" size={17} color={theme.colors.textFaint} />} />
    </View>
    <Pressable disabled={signingOut} onPress={handleSignOut} style={({ pressed }) => ({ marginHorizontal: 16, marginTop: 26, minHeight: 48, borderRadius: 13, borderWidth: 1, borderColor: theme.colors.danger, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.dangerSoft : "transparent", opacity: signingOut ? 0.55 : 1 })}><Text style={[typography.bodyMedium, { color: theme.colors.danger }]}>{signingOut ? "Signing out…" : "Sign out"}</Text></Pressable>
    <Text style={[typography.micro, { color: theme.colors.textFaint, textAlign: "center", marginTop: 22, marginBottom: 8 }]}>Cohub Mobile · {Application.nativeApplicationVersion ?? "1.0.0"}</Text>
  </Screen>;
}

function SettingRow({ icon, title, detail, trailing, onPress }: { icon: React.ComponentProps<typeof AppIcon>["name"]; title: string; detail: string; trailing?: React.ReactNode; onPress?: () => void }) {
  const theme = useAppTheme();
  const content = <View style={{ minHeight: 62, flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 13, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}><View style={{ width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceRaised }}><AppIcon name={icon} size={16} color={theme.colors.textMuted} /></View><View style={{ flex: 1, minWidth: 0 }}><Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{title}</Text><Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>{detail}</Text></View>{trailing}</View>;
  return onPress ? <Pressable onPress={onPress} style={({ pressed }) => ({ backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}>{content}</Pressable> : content;
}
