import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, BrandMark, ConnectionBanner, DataError, EmptyState, IconButton, LoadingRows, Screen, SectionHeader, StatusPill, TopBar, getStatusTone } from "@/src/ui";
import { formatNumber, formatRelativeTime } from "@/src/utils";
import { PressableScale } from "@/src/ui/PressableScale";

export default function ActivityScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const { state, activityItems, connectionState, refreshHome } = useApp();
  const dataError = state.error ?? state.sessionsError ?? state.sessionStatusError ?? state.activityError;
  const [filter, setFilter] = useState<"all" | "running" | "complete">("all");
  const items = useMemo(() => filter === "all" ? activityItems : activityItems.filter((item) => item.status === filter), [activityItems, filter]);
  return <Screen scroll refreshing={state.refreshing} onRefresh={() => void refreshHome()}>
    <TopBar title="Activity" subtitle={dataError ? "Activity unavailable" : "Agent runs and results"} left={<BrandMark size={40} />} right={<IconButton name="refresh" label="Refresh activity" size={40} onPress={() => void refreshHome()} />} />
    <ConnectionBanner state={connectionState} />
    {dataError ? <DataError message={dataError} onRetry={() => void refreshHome()} /> : null}
    <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 14, gap: 10 }}>
      <Metric label="Requests" value={state.activityLoading ? "…" : formatNumber(state.usage?.requestCount)} icon="zap" />
      <Metric label="Successful" value={state.activityLoading ? "…" : formatNumber(state.usage?.successCount)} icon="check-circle" tone="success" />
      <Metric label="Tokens" value={state.activityLoading ? "…" : formatNumber(state.usage?.totalTokens)} icon="layers" tone="info" />
    </View>
    <SectionHeader title="Recent work" action={items.length > 0 ? `${items.length} items` : undefined} onAction={() => setFilter("all")} />
    <View style={{ paddingHorizontal: 16, flexDirection: "row", gap: 8 }}>
      <ActivityFilter label="All" selected={filter === "all"} onPress={() => setFilter("all")} />
      <ActivityFilter label="Running" selected={filter === "running"} onPress={() => setFilter("running")} />
      <ActivityFilter label="Completed" selected={filter === "complete"} onPress={() => setFilter("complete")} />
    </View>
    <View style={{ marginTop: 10 }}>
      {dataError && items.length === 0 ? <EmptyState icon="cloud-off" title="Activity is unavailable" description="Retry above after checking your connection and sign-in session." /> : state.booting || (state.sessionStatusRequests > 0 && items.length === 0) ? <LoadingRows count={4} /> : items.length > 0 ? items.map((item) => <PressableScale key={item.id} accessibilityRole="button" onPress={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: item.sessionId } })} haptic style={{ flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: theme.colors.border }} pressedStyle={{ backgroundColor: theme.colors.surfacePressed }}>
        <View style={[{ width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center" }, { backgroundColor: item.status === "running" ? theme.colors.warningSoft : item.status === "failed" ? theme.colors.dangerSoft : item.status === "stopped" ? theme.colors.surfaceRaised : theme.colors.successSoft }]}><AppIcon name={item.status === "running" ? "sync" : item.status === "failed" ? "alert" : item.status === "stopped" ? "stop" : "check"} size={17} color={item.status === "running" ? theme.colors.warning : item.status === "failed" ? theme.colors.danger : item.status === "stopped" ? theme.colors.textMuted : theme.colors.success} /></View>
        <View style={{ flex: 1, minWidth: 0 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, flex: 1 }]}>{item.title}</Text><Text style={[typography.micro, { color: theme.colors.textFaint }]}>{formatRelativeTime(item.updatedAt)}</Text></View><Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 3 }]}>{item.spaceName} · {item.preview}</Text></View>
        <StatusPill label={item.status === "running" ? "Running" : item.status === "failed" ? "Failed" : item.status === "stopped" ? "Stopped" : "Done"} tone={getStatusTone(item.status)} />
      </PressableScale>) : <EmptyState icon="activity" title="No recent Agent work" description="Completed, running, and failed Agent runs will appear here." />}
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
