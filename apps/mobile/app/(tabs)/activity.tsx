import { useRouter, useScrollToTop } from "expo-router";
import { useRef } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { AccountAvatar } from "@/src/components/AccountAvatar";
import { useFloatingTabBarInset } from "@/src/components/FloatingTabBar";
import { TokenHeatmap } from "@/src/components/TokenHeatmap";
import { useApp } from "@/src/data/context";
import { useActivity } from "@/src/data/use-activity";
import { useAppTheme, typography } from "@/src/theme";
import { useTranslation } from "@/src/i18n";
import { AppIcon, ConnectionBanner, DataError, LoadingRows, Screen, SectionHeader, TopBar } from "@/src/ui";
import { PressableScale } from "@/src/ui/PressableScale";

export default function ActivityScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const tabBarInset = useFloatingTabBarInset();
  const { connectionState } = useApp();
  const { credits, days, loading, refresh } = useActivity();
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);
  const retry = () => void refresh();
  return <Screen>
    <TopBar title={t("activity.title")} leading={<AccountAvatar />} />
    <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: tabBarInset }} refreshControl={<RefreshControl refreshing={loading} onRefresh={retry} tintColor={theme.colors.accent} colors={[theme.colors.accent]} />}>
      <ConnectionBanner state={connectionState} />
      <PressableScale accessibilityRole="button" accessibilityLabel={t("settings.section.billing")} onPress={() => router.push("/settings/billing")} style={{ padding: theme.spacing.lg, gap: theme.spacing.sm }} pressedStyle={{ backgroundColor: theme.colors.surfacePressed }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
          <AppIcon name="database" size={17} color={theme.colors.accent} />
          <Text style={[typography.caption, { flex: 1, color: theme.colors.textMuted }]}>{t("settings.billing.balance")}</Text>
          <AppIcon name="chevron-right" size={17} color={theme.colors.textMuted} />
        </View>
        <Text style={[typography.title, { color: credits.data && credits.data.netUsd < 0 ? theme.colors.danger : theme.colors.text }]}>{credits.data ? `$${credits.data.netUsd.toFixed(2)}` : "—"}</Text>
      </PressableScale>
      {credits.error ? <DataError message={credits.error} onRetry={retry} /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: theme.spacing.lg, gap: theme.spacing.lg }}>
        {(["activity", "referrals"] as const).map((section) => <PressableScale key={section} accessibilityRole="button" onPress={() => router.push(`/settings/${section}`)} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}><AppIcon name={section === "activity" ? "activity" : "gift"} size={16} color={theme.colors.accent} /><Text style={[typography.caption, { color: theme.colors.accent }]}>{t(section === "activity" ? "activity.usageDetails" : "settings.section.referrals")}</Text></PressableScale>)}
      </View>
      <SectionHeader title={t("activity.heatmap.title")} />
      {days.error ? <DataError message={days.error} onRetry={retry} /> : null}
      {days.data ? <TokenHeatmap days={days.data} /> : !days.error ? <LoadingRows count={2} /> : null}
    </ScrollView>
  </Screen>;
}
