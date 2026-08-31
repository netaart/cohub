import { useEffect, useState } from "react";
import { AppState as NativeAppState, Linking, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, PrimaryButton } from "@/src/ui";
import {
  checkForAppUpdate,
  getInstalledAppVersion,
  isUpdateSnoozed,
  snoozeAppUpdate,
  type AppRelease,
} from "@/src/platform/app-updates";

export function AppUpdateBanner() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const [release, setRelease] = useState<AppRelease | null>(null);
  const [snoozedVersion, setSnoozedVersion] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    let active = true;

    const check = async () => {
      try {
        const latest = await checkForAppUpdate();
        const snoozed = latest ? await isUpdateSnoozed(latest.version) : false;
        if (!active) return;
        setSnoozedVersion(snoozed && latest ? latest.version : null);
        setRelease((current) => {
          if (!latest || snoozed) return null;
          return current?.version === latest.version &&
            current.url === latest.url &&
            current.downloadUrl === latest.downloadUrl
            ? current
            : latest;
        });
      } catch {
        // An update check is optional and must not affect app startup.
      }
    };

    void check();
    const subscription = NativeAppState.addEventListener("change", (next) => {
      if (next === "active") void check();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  if (Platform.OS !== "android" || !release || release.version === snoozedVersion) return null;

  const close = () => {
    void snoozeAppUpdate(release.version).catch(() => undefined);
    setSnoozedVersion(release.version);
    setRelease(null);
    setDetailsOpen(false);
  };

  const openRelease = async () => {
    const url = release.downloadUrl ?? release.url;
    try {
      await Linking.openURL(url);
      close();
    } catch {
      if (url !== release.url) {
        try {
          await Linking.openURL(release.url);
          close();
          return;
        } catch {
          // Keep the sheet open so the user can retry from the release details.
        }
      }
      setDetailsOpen(true);
    }
  };

  return (
    <>
      <View pointerEvents="box-none" style={[styles.bannerLayer, { top: insets.top + 8 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Update available: ${release.version}`}
          onPress={() => setDetailsOpen(true)}
          android_ripple={{ color: theme.colors.pressOverlay }}
          style={({ pressed }) => ({
            ...styles.banner,
            backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface,
            borderColor: theme.colors.accentBorder,
            shadowColor: theme.colors.shadow,
          })}
        >
          <View style={[styles.bannerIcon, { backgroundColor: theme.colors.accentSoft }]}>
            <AppIcon name="refresh" size={17} color={theme.colors.accent} />
          </View>
          <View style={styles.bannerText}>
            <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>Cohub {release.version} is ready</Text>
            <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 1 }]}>Tap to view the release</Text>
          </View>
          <AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} />
        </Pressable>
      </View>

      <AdaptiveSheet
        visible={detailsOpen}
        title={`Cohub ${release.version} is available`}
        subtitle={`You are using ${getInstalledAppVersion()}.`}
        onClose={() => setDetailsOpen(false)}
        scrollable
        footer={
          <View style={styles.footer}>
            <Pressable onPress={close} style={({ pressed }) => ({ ...styles.laterButton, opacity: pressed ? 0.6 : 1 })}>
              <Text style={[typography.bodyMedium, { color: theme.colors.textSecondary }]}>Later</Text>
            </Pressable>
            <PrimaryButton label={release.downloadUrl ? "Download update" : "View release"} icon={release.downloadUrl ? "download" : "external-link"} onPress={() => void openRelease()} style={{ minHeight: 46, paddingHorizontal: 16 }} />
          </View>
        }
        testID="app-update-sheet"
      >
        <View style={[styles.releaseNotice, { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accentBorder }]}>
          <AppIcon name="info" size={17} color={theme.colors.accent} />
          <Text style={[typography.body, { color: theme.colors.textSecondary, flex: 1 }]}>{release.downloadUrl ? "Download the signed APK for this device, then install it over your current app. If Android reports a signature mismatch, remove the old debug build first." : "Open the GitHub release page to choose the signed APK for this device."}</Text>
        </View>
        {release.notes ? <Text selectable style={[typography.caption, { color: theme.colors.textMuted, marginTop: 16 }]}>{release.notes}</Text> : null}
      </AdaptiveSheet>
    </>
  );
}

const styles = {
  bannerLayer: {
    position: "absolute" as const,
    left: 12,
    right: 12,
    zIndex: 100,
    alignItems: "center" as const,
  },
  banner: {
    width: "100%" as const,
    maxWidth: 520,
    minHeight: 58,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderRadius: 14,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 10,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 7,
  },
  bannerIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  bannerText: {
    flex: 1,
    minWidth: 0,
  },
  footer: {
    flexDirection: "row" as const,
    justifyContent: "flex-end" as const,
    alignItems: "center" as const,
    gap: 10,
  },
  laterButton: {
    minHeight: 46,
    paddingHorizontal: 15,
    justifyContent: "center" as const,
  },
  releaseNotice: {
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    gap: 9,
    padding: 12,
    borderWidth: 1,
    borderRadius: 12,
  },
} satisfies Record<string, object>;
