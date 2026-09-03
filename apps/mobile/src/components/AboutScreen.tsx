import { useRouter } from "expo-router";
import { useState } from "react";
import { Image, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { AppUpdateRow } from "@/src/components/AppUpdateBanner";
import { getInstalledAppVersion } from "@/src/platform/app-updates";
import { AppIcon, DetailTopBar, Screen, SectionHeader } from "@/src/ui";
import { useAppTheme, typography } from "@/src/theme";
import type { IconName } from "@/src/icons";

const REPOSITORY_URL = "https://github.com/markbang/cohub-mobile";
const RELEASES_URL = `${REPOSITORY_URL}/releases`;
const LICENSE_URL = `${REPOSITORY_URL}/blob/main/LICENSE`;
const COHUB_URL = "https://cohub.live";

export function AboutScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <Screen>
      <DetailTopBar title="About" subtitle="Cohub Mobile" onBack={() => router.back()} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        showsVerticalScrollIndicator={false}
      >
        <AboutContent />
      </ScrollView>
    </Screen>
  );
}

export function AboutContent({ onNotice }: { onNotice?: (notice: { title: string; message: string }) => void } = {}) {
  const theme = useAppTheme();
  const [notice, setNotice] = useState<Notice | null>(null);
  const version = getInstalledAppVersion();

  const openExternal = async (url: string, title: string) => {
    try {
      await Linking.openURL(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Unable to open ${title.toLowerCase()}.`;
      if (onNotice) onNotice({ title: `${title} unavailable`, message });
      else setNotice({ title: `${title} unavailable`, message });
    }
  };

  return (
    <View testID="about-content">
      <View style={styles.hero}>
        <Image source={require("../../assets/images/icon.png")} resizeMode="contain" style={styles.logo} />
        <Text style={[typography.title, { color: theme.colors.text, marginTop: 14 }]}>Cohub Mobile</Text>
        <Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 5, textAlign: "center" }]}>A native client for Cohub</Text>
        <View style={[styles.versionPill, { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accentBorder }]}>
          <Text style={[typography.caption, { color: theme.colors.accent }]}>Version {version}</Text>
        </View>
      </View>

      <SectionHeader title="Application" />
      <View style={[styles.group, { marginHorizontal: 16, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        <AboutRow icon="info" title="Version" detail={version} />
        <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />
        <AppUpdateRow />
      </View>

      <SectionHeader title="Links" />
      <View style={[styles.group, { marginHorizontal: 16, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        <AboutRow icon="code" title="Source code" detail="github.com/markbang/cohub-mobile" onPress={() => void openExternal(REPOSITORY_URL, "Source code")} />
        <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />
        <AboutRow icon="book-open" title="Release notes" detail="View published versions" onPress={() => void openExternal(RELEASES_URL, "Release notes")} />
        <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />
        <AboutRow icon="globe" title="Cohub website" detail="cohub.live" onPress={() => void openExternal(COHUB_URL, "Cohub website")} />
      </View>

      <SectionHeader title="Legal" />
      <View style={[styles.group, { marginHorizontal: 16, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        <AboutRow icon="shield" title="Open-source license" detail="Apache License 2.0" onPress={() => void openExternal(LICENSE_URL, "License")} />
      </View>

      <Text style={[typography.caption, { color: theme.colors.textFaint, textAlign: "center", marginHorizontal: 24, marginTop: 24 }]}>Built with React Native and Expo.</Text>

      {!onNotice ? (
        <AdaptiveSheet
          visible={notice !== null}
          title={notice?.title ?? "Unable to open link"}
          onClose={() => setNotice(null)}
          scrollable={false}
          testID="about-link-error-sheet"
        >
          <Text style={[typography.body, { color: theme.colors.textSecondary }]}>{notice?.message}</Text>
        </AdaptiveSheet>
      ) : null}
    </View>
  );
}

type Notice = { title: string; message: string };

function AboutRow({ icon, title, detail, onPress }: { icon: IconName; title: string; detail: string; onPress?: () => void }) {
  const theme = useAppTheme();
  const content = (
    <View style={styles.row}>
      <View style={[styles.rowIcon, { backgroundColor: theme.colors.surfaceRaised }]}>
        <AppIcon name={icon} size={17} color={theme.colors.textMuted} />
      </View>
      <View style={styles.rowText}>
        <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{title}</Text>
        <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>{detail}</Text>
      </View>
      {onPress ? <AppIcon name="external-link" size={16} color={theme.colors.textFaint} /> : null}
    </View>
  );
  return onPress ? (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={title}
      onPress={onPress}
      android_ripple={{ color: theme.colors.pressOverlay }}
      style={({ pressed }) => ({ backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}
    >
      {content}
    </Pressable>
  ) : content;
}

const styles = {
  hero: { alignItems: "center" as const, paddingHorizontal: 16, paddingTop: 26, paddingBottom: 10 },
  logo: { width: 82, height: 82, borderRadius: 22 },
  versionPill: { marginTop: 12, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderRadius: 999 },
  group: { borderWidth: 1, borderRadius: 14, overflow: "hidden" as const },
  separator: { height: 1, marginLeft: 58 },
  row: { minHeight: 68, paddingHorizontal: 13, paddingVertical: 10, flexDirection: "row" as const, alignItems: "center" as const, gap: 11 },
  rowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center" as const, justifyContent: "center" as const },
  rowText: { flex: 1, minWidth: 0 },
} satisfies Record<string, object>;
