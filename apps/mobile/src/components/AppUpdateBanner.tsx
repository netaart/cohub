import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState as NativeAppState, Linking, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { ReleaseNotes } from "@/src/components/ReleaseNotes";
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
  const presentedVersion = useRef<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    let active = true;

    const check = async () => {
      try {
        const latest = await checkForAppUpdate();
        const snoozed = latest ? await isUpdateSnoozed(latest.version) : false;
        if (!active) return;
        setSnoozedVersion(snoozed && latest ? latest.version : null);
        if (latest && !snoozed && presentedVersion.current !== latest.version) {
          presentedVersion.current = latest.version;
          setDetailsOpen(true);
        }
        setRelease((current) => {
          if (!latest || snoozed) return null;
          return current?.version === latest.version &&
            current.title === latest.title &&
            current.publishedAt === latest.publishedAt &&
            current.url === latest.url &&
            current.notes === latest.notes &&
            current.downloadUrl === latest.downloadUrl &&
            current.downloadName === latest.downloadName &&
            current.downloadSize === latest.downloadSize
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

  const dismiss = () => {
    void snoozeAppUpdate(release.version).catch(() => undefined);
    setSnoozedVersion(release.version);
    setRelease(null);
    setDetailsOpen(false);
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
            <AppIcon name="download" size={17} color={theme.colors.accent} />
          </View>
          <View style={styles.bannerText}>
            <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>Update available · {release.version}</Text>
            <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 1 }]}>{release.title ?? "View release notes"}</Text>
          </View>
          <AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} />
        </Pressable>
      </View>

      <AppUpdateDetailsSheet
        key={`banner-${release.version}-${detailsOpen ? "open" : "closed"}`}
        release={release}
        visible={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        onLater={dismiss}
        onPrimarySuccess={dismiss}
      />
    </>
  );
}

export function AppUpdateDetailsSheet({
  release,
  visible,
  onClose,
  onLater,
  onPrimarySuccess,
}: {
  release: AppRelease;
  visible: boolean;
  onClose: () => void;
  onLater?: () => void;
  onPrimarySuccess?: () => void;
}) {
  const theme = useAppTheme();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const releaseDate = formatReleaseDate(release.publishedAt);
  const assetDetail = release.downloadName
    ? `${release.downloadName}${release.downloadSize !== null ? ` · ${formatBytes(release.downloadSize)}` : ""}`
    : null;

  const openUrl = async (url: string, closeAfter = false, fallbackUrl?: string) => {
    if (opening) return;
    setOpening(true);
    setError(null);
    try {
      await Linking.openURL(url);
      if (closeAfter) (onPrimarySuccess ?? onClose)();
    } catch (caught) {
      if (fallbackUrl && fallbackUrl !== url) {
        try {
          await Linking.openURL(fallbackUrl);
          if (closeAfter) (onPrimarySuccess ?? onClose)();
          return;
        } catch {
          // Surface the original failure when neither link can be opened.
        }
      }
      setError(caught instanceof Error ? caught.message : "Unable to open the release link.");
    } finally {
      setOpening(false);
    }
  };

  return (
    <AdaptiveSheet
      visible={visible}
      title="Update available"
      subtitle={`Cohub ${release.version}`}
      onClose={onClose}
      scrollable
      footer={
        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Not now"
            onPress={onLater ?? onClose}
            disabled={opening}
            style={({ pressed }) => ({ ...styles.laterButton, opacity: pressed || opening ? 0.6 : 1 })}
          >
            <Text style={[typography.bodyMedium, { color: theme.colors.textSecondary }]}>Not now</Text>
          </Pressable>
          <PrimaryButton
            label={release.downloadUrl ? "Download update" : "Open release"}
            icon={release.downloadUrl ? "download" : "external-link"}
            loading={opening}
            onPress={() => void openUrl(release.downloadUrl ?? release.url, true, release.url)}
            style={{ flex: 1, minWidth: 0, minHeight: 46, paddingHorizontal: 14 }}
          />
        </View>
      }
      testID="app-update-sheet"
    >
      <View style={[styles.releaseSummary, { backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.border }]}>
        <View style={[styles.releaseSummaryIcon, { backgroundColor: theme.colors.accentSoft }]}>
          <AppIcon name="download" size={20} color={theme.colors.accent} />
        </View>
        <View style={styles.releaseSummaryText}>
          <Text style={[typography.heading, { color: theme.colors.text }]}>{release.title ?? `Cohub ${release.version}`}</Text>
          <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 3 }]}>
            {[release.version, releaseDate].filter(Boolean).join(" · ")}
          </Text>
          {assetDetail ? <Text numberOfLines={2} style={[typography.caption, { color: theme.colors.accent, marginTop: 3 }]}>{assetDetail}</Text> : null}
        </View>
      </View>

      <View style={[styles.releaseNotice, { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accentBorder }]}>
        <AppIcon name="info" size={17} color={theme.colors.accent} />
        <Text style={[typography.body, { color: theme.colors.textSecondary, flex: 1 }]}>
          {release.downloadUrl
            ? "Download the signed APK for this device, then open it from your Downloads to install it over the current app."
            : "Open the GitHub release page to view the published update."}
        </Text>
      </View>

      <View style={{ marginTop: 18 }}>
        <ReleaseNotes content={release.notes} />
      </View>

      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Open release on GitHub"
        onPress={() => void openUrl(release.url)}
        disabled={opening}
        style={({ pressed }) => [styles.githubLink, { borderColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent", opacity: opening ? 0.55 : 1 }]}
      >
        <AppIcon name="external-link" size={16} color={theme.colors.accent} />
        <Text style={[typography.bodyMedium, { color: theme.colors.accent, flex: 1 }]}>Open release on GitHub</Text>
        <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} />
      </Pressable>
      {error ? <Text selectable style={[typography.caption, { color: theme.colors.danger, marginTop: 10 }]}>{error}</Text> : null}
    </AdaptiveSheet>
  );
}

export function AppUpdateRow() {
  const theme = useAppTheme();
  const [checking, setChecking] = useState(false);
  const [release, setRelease] = useState<AppRelease | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "current" | "error">("idle");

  if (Platform.OS === "web") return null;

  const check = async () => {
    if (checking) return;
    setChecking(true);
    setRelease(null);
    setDetailsOpen(false);
    setStatus("idle");
    try {
      const latest = await checkForAppUpdate({ force: true });
      setRelease(latest);
      setStatus(latest ? "idle" : "current");
      if (latest) setDetailsOpen(true);
    } catch {
      setStatus("error");
    } finally {
      setChecking(false);
    }
  };

  const title = release ? `Update available · ${release.version}` : "Check for updates";
  const detail = checking
    ? "Checking GitHub..."
    : status === "current"
      ? `You are up to date · ${getInstalledAppVersion()}`
      : status === "error"
        ? "GitHub could not be reached. Tap to retry."
        : release?.downloadUrl
          ? "Release notes and a signed APK are ready"
          : release
            ? "Release notes are ready on GitHub"
            : "Check the latest Cohub release";

  return (
    <>
      <Pressable
        testID="app-update-row"
        accessibilityRole="button"
        accessibilityLabel={release ? `View Cohub ${release.version} update` : "Check for app updates"}
        accessibilityState={{ busy: checking }}
        disabled={checking}
        onPress={() => {
          if (release) setDetailsOpen(true);
          else void check();
        }}
        android_ripple={{ color: theme.colors.pressOverlay }}
        style={({ pressed }) => ({
          minHeight: 66,
          paddingHorizontal: 13,
          paddingVertical: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: 11,
          backgroundColor: pressed ? theme.colors.surfacePressed : "transparent",
          opacity: checking ? 0.65 : 1,
        })}
      >
        <View style={[styles.updateRowIcon, { backgroundColor: release ? theme.colors.accentSoft : theme.colors.surfaceRaised }]}>
          {checking ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <AppIcon name={release ? "download" : "refresh"} size={17} color={theme.colors.accent} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{title}</Text>
          <Text numberOfLines={2} style={[typography.caption, { color: release ? theme.colors.accent : theme.colors.textMuted, marginTop: 2 }]}>{detail}</Text>
        </View>
        {!checking ? <AppIcon name={release ? "external-link" : "chevron-right"} size={17} color={theme.colors.textFaint} /> : null}
      </Pressable>
      {release ? <AppUpdateDetailsSheet key={`row-${release.version}-${detailsOpen ? "open" : "closed"}`} release={release} visible={detailsOpen} onClose={() => setDetailsOpen(false)} /> : null}
    </>
  );
}

function formatReleaseDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
  updateRowIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  releaseSummary: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 11,
    padding: 12,
    borderWidth: 1,
    borderRadius: 13,
  },
  releaseSummaryIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  releaseSummaryText: {
    flex: 1,
    minWidth: 0,
  },
  releaseNotice: {
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    gap: 9,
    padding: 12,
    borderWidth: 1,
    borderRadius: 12,
    marginTop: 12,
  },
  githubLink: {
    minHeight: 48,
    marginTop: 18,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderRadius: 11,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 9,
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
} satisfies Record<string, object>;
