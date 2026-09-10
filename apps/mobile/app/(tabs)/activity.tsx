import { useRouter, useScrollToTop } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { AccountAvatar } from "@/src/components/AccountAvatar";
import { useFloatingTabBarInset } from "@/src/components/FloatingTabBar";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { useTranslation } from "@/src/i18n";
import { AppIcon, ConnectionBanner, DataError, EmptyState, IconButton, LoadingRows, Screen, SectionHeader, StatusPill, TopBar, getStatusTone } from "@/src/ui";
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
  return <Screen scroll scrollRef={scrollRef} refreshing={state.refreshing} onRefresh={() => void refreshHome()} contentStyle={{ paddingBottom: tabBarInset }}>
    <TopBar title={t("activity.title")} subtitle={dataError ? t("activity.subtitleUnavailable") : t("activity.subtitle")} left={<AccountAvatar size={40} />} right={<IconButton name="refresh" label={t("activity.refresh")} size={40} onPress={() => void refreshHome()} />} />
    <ConnectionBanner state={connectionState} />
    {dataError ? <DataError message={dataError} onRetry={() => void refreshHome()} /> : null}
    <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 14, gap: 10 }}>
      <Metric label={t("activity.metric.requests")} value={state.activityLoading ? "…" : formatNumber(state.usage?.requestCount)} icon="zap" />
      <Metric label={t("activity.metric.successful")} value={state.activityLoading ? "…" : formatNumber(state.usage?.successCount)} icon="check-circle" tone="success" />
      <Metric label={t("activity.metric.tokens")} value={state.activityLoading ? "…" : formatNumber(state.usage?.totalTokens)} icon="layers" tone="info" />
    </View>
    <SectionHeader title={t("activity.section.recent")} action={items.length > 0 ? t("activity.section.items", { count: items.length }) : undefined} onAction={() => setFilter("all")} />
    <View style={{ paddingHorizontal: 16, flexDirection: "row", gap: 8 }}>
      <ActivityFilter label={t("activity.filter.all")} selected={filter === "all"} onPress={() => setFilter("all")} />
      <ActivityFilter label={t("activity.filter.running")} selected={filter === "running"} onPress={() => setFilter("running")} />
      <ActivityFilter label={t("activity.filter.completed")} selected={filter === "complete"} onPress={() => setFilter("complete")} />
    </View>
    <View style={{ marginTop: 10 }}>
      {dataError && items.length === 0 ? <EmptyState icon="cloud-off" title={t("activity.error.title")} description={t("activity.error.body")} /> : state.booting || (state.sessionStatusRequests > 0 && items.length === 0) ? <LoadingRows count={4} /> : items.length > 0 ? items.map((item) => <PressableScale key={item.id} accessibilityRole="button" onPress={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: item.sessionId } })} haptic style={{ flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: theme.colors.border }} pressedStyle={{ backgroundColor: theme.colors.surfacePressed }}>
        <View style={[{ width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center" }, { backgroundColor: item.status === "running" ? theme.colors.warningSoft : item.status === "failed" ? theme.colors.dangerSoft : item.status === "stopped" ? theme.colors.surfaceRaised : theme.colors.successSoft }]}><AppIcon name={item.status === "running" ? "sync" : item.status === "failed" ? "alert" : item.status === "stopped" ? "stop" : "check"} size={17} color={item.status === "running" ? theme.colors.warning : item.status === "failed" ? theme.colors.danger : item.status === "stopped" ? theme.colors.textMuted : theme.colors.success} /></View>
        <View style={{ flex: 1, minWidth: 0 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, flex: 1 }]}>{item.title}</Text><Text style={[typography.micro, { color: theme.colors.textFaint }]}>{formatRelativeTime(item.updatedAt)}</Text></View><Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 3 }]}>{item.spaceName} · {item.preview}</Text></View>
        <StatusPill label={item.status === "running" ? t("ui.status.running") : item.status === "failed" ? t("ui.status.failed") : item.status === "stopped" ? t("ui.status.stopped") : t("ui.status.done")} tone={getStatusTone(item.status)} />
      </PressableScale>) : <EmptyState icon="activity" title={t("activity.empty.title")} description={t("activity.empty.body")} />}
    </View>
  </Screen>;
}

function Metric({ label, value, icon, tone = "default" }: { label: string; value: string; icon: React.ComponentProps<typeof AppIcon>["name"]; tone?: "default" | "success" | "info" }) {
  const theme = useAppTheme();
  const color = tone === "success" ? theme.colors.success : tone === "info" ? theme.colors.info : theme.colors.accent;
  return <View style={{ flex: 1, minHeight: 82, padding: 11, borderRadius: 13, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }}><AppIcon name={icon} size={16} color={color} /><Text style={[typography.heading, { color: theme.colors.text, marginTop: 8 }]}>{value}</Text><Text style={[typography.micro, { color: theme.colors.textMuted, marginTop: 2 }]}>{label}</Text></View>;
}

function ActivityFilter({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useAppTheme();
  return <PressableScale accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} style={{ paddingHorizontal: 12, minHeight: 32, borderRadius: 999, justifyContent: "center", backgroundColor: selected ? theme.colors.accentSoft : theme.colors.surface, borderWidth: 1, borderColor: selected ? theme.colors.accentBorder : theme.colors.border }} pressedStyle={{ backgroundColor: theme.colors.surfacePressed }}><Text style={[typography.caption, { color: selected ? theme.colors.accent : theme.colors.textMuted }]}>{label}</Text></PressableScale>;
}
