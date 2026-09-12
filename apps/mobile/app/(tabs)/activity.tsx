import { useRouter, useScrollToTop } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { AccountAvatar } from "@/src/components/AccountAvatar";
import { useFloatingTabBarInset } from "@/src/components/FloatingTabBar";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { useTranslation } from "@/src/i18n";
import { AppIcon, ConnectionBanner, DataError, EmptyState, LoadingRows, Screen, SectionHeader, TopBar } from "@/src/ui";
import { IconSegmentedControl } from "@/src/ui/IconSegmentedControl";
import { formatNumber, formatRelativeTime } from "@/src/utils";
import { PressableScale } from "@/src/ui/PressableScale";

export default function ActivityScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const tabBarInset = useFloatingTabBarInset();
  const { state, activityItems, connectionState, refreshHome } = useApp();
  const dataError = state.error ?? state.sessionsError ?? state.sessionStatusError ?? state.activityError;
  const [filter, setFilter] = useState<"all" | "running" | "complete">("all");
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);
  const items = useMemo(() => filter === "all" ? activityItems : activityItems.filter((item) => item.status === filter), [activityItems, filter]);
  return <Screen>
    <TopBar title={t("activity.title")} leading={<AccountAvatar />} />
    <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: tabBarInset }} refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={() => void refreshHome()} tintColor={theme.colors.accent} colors={[theme.colors.accent]} />}>
    <ConnectionBanner state={connectionState} />
    {dataError ? <DataError message={dataError} onRetry={() => void refreshHome()} /> : null}
    <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 14, gap: 10 }}>
      <Metric label={t("activity.metric.requests")} value={state.activityLoading ? "…" : formatNumber(state.usage?.requestCount)} icon="zap" />
      <Metric label={t("activity.metric.successful")} value={state.activityLoading ? "…" : formatNumber(state.usage?.successCount)} icon="check-circle" tone="success" />
      <Metric label={t("activity.metric.tokens")} value={state.activityLoading ? "…" : formatNumber(state.usage?.totalTokens)} icon="layers" tone="info" />
    </View>
    <SectionHeader title={t("activity.section.recent")} />
    <View style={{ paddingHorizontal: 16 }}>
      <IconSegmentedControl<"all" | "running" | "complete"> value={filter} onChange={setFilter} options={[
        { value: "all", icon: "layers", label: t("activity.filter.all") },
        { value: "running", icon: "activity", label: t("activity.filter.running") },
        { value: "complete", icon: "check-circle", label: t("activity.filter.completed") },
      ]} />
    </View>
    <View style={{ marginTop: 10 }}>
      {dataError && items.length === 0 ? <EmptyState icon="cloud-off" title={t("activity.error.title")} description={t("activity.error.body")} /> : state.booting || (state.sessionStatusRequests > 0 && items.length === 0) ? <LoadingRows count={4} /> : items.length > 0 ? items.map((item) => <PressableScale key={item.id} accessibilityRole="button" onPress={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: item.sessionId } })} haptic style={{ flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: theme.colors.border }} pressedStyle={{ backgroundColor: theme.colors.surfacePressed }}>
        <View accessible accessibilityLabel={item.status === "running" ? t("ui.status.running") : item.status === "failed" ? t("ui.status.failed") : item.status === "stopped" ? t("ui.status.stopped") : t("ui.status.done")} style={{ width: 34, height: 34, alignItems: "center", justifyContent: "center" }}><AppIcon name={item.status === "running" ? "sync" : item.status === "failed" ? "alert" : item.status === "stopped" ? "stop" : "check"} size={17} color={item.status === "running" ? theme.colors.warning : item.status === "failed" ? theme.colors.danger : item.status === "stopped" ? theme.colors.textMuted : theme.colors.success} /></View>
        <View style={{ flex: 1, minWidth: 0 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, flex: 1 }]}>{item.title}</Text><Text style={[typography.micro, { color: theme.colors.textFaint }]}>{formatRelativeTime(item.updatedAt)}</Text></View><Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 3 }]}>{item.spaceName} · {item.preview}</Text></View>
      </PressableScale>) : <EmptyState icon="activity" title={t("activity.empty.title")} />}
    </View>
    </ScrollView>
  </Screen>;
}

function Metric({ label, value, icon, tone = "default" }: { label: string; value: string; icon: React.ComponentProps<typeof AppIcon>["name"]; tone?: "default" | "success" | "info" }) {
  const theme = useAppTheme();
  const color = tone === "success" ? theme.colors.success : tone === "info" ? theme.colors.info : theme.colors.accent;
  return <View style={{ flex: 1, minWidth: 0, minHeight: 82, padding: 8 }}><AppIcon name={icon} size={16} color={color} /><Text style={[typography.heading, { color: theme.colors.text, marginTop: 8 }]}>{value}</Text><Text style={[typography.micro, { color: theme.colors.textMuted, marginTop: 2 }]}>{label}</Text></View>;
}
