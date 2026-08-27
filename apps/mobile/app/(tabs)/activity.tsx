import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, BrandMark, ConnectionBanner, EmptyState, IconButton, Screen, SectionHeader, StatusPill, TopBar, getStatusTone } from "@/src/ui";
import { formatNumber, formatRelativeTime } from "@/src/utils";

export default function ActivityScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const { state, activityItems, connectionState, refreshHome } = useApp();
  const [filter, setFilter] = useState<"all" | "running" | "attention">("all");
  const items = useMemo(() => filter === "all" ? activityItems : activityItems.filter((item) => item.status === filter), [activityItems, filter]);
  return <Screen scroll refreshing={state.refreshing} onRefresh={() => void refreshHome()}>
    <TopBar title="Activity" subtitle="What needs your attention" left={<BrandMark size={36} />} right={<IconButton name="refresh-outline" label="Refresh activity" size={38} onPress={() => void refreshHome()} />} />
    <ConnectionBanner state={connectionState} />
    <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 16, gap: 10 }}>
      <Metric label="Requests" value={formatNumber(state.usage?.requestCount)} icon="flash-outline" />
      <Metric label="Successful" value={formatNumber(state.usage?.successCount)} icon="checkmark-circle-outline" tone="success" />
      <Metric label="Tokens" value={formatNumber(state.usage?.totalTokens)} icon="layers-outline" tone="info" />
    </View>
    <SectionHeader title="Recent work" />
    <View style={{ paddingHorizontal: 16, flexDirection: "row", gap: 8 }}>
      <ActivityFilter label="All" selected={filter === "all"} onPress={() => setFilter("all")} />
      <ActivityFilter label="Running" selected={filter === "running"} onPress={() => setFilter("running")} />
      <ActivityFilter label="Needs you" selected={filter === "attention"} onPress={() => setFilter("attention")} />
    </View>
    <View style={{ marginTop: 10 }}>
      {items.length > 0 ? items.map((item) => <Pressable key={item.id} onPress={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: item.sessionId } })} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 16, paddingVertical: 13, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}>
        <View style={[{ width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center" }, { backgroundColor: item.status === "running" ? theme.colors.warningSoft : item.status === "attention" ? theme.colors.dangerSoft : theme.colors.successSoft }]}><AppIcon name={item.status === "running" ? "sync-outline" : item.status === "attention" ? "alert-outline" : "checkmark-outline"} size={17} color={item.status === "running" ? theme.colors.warning : item.status === "attention" ? theme.colors.danger : theme.colors.success} /></View>
        <View style={{ flex: 1, minWidth: 0 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, flex: 1 }]}>{item.title}</Text><Text style={[typography.micro, { color: theme.colors.textFaint }]}>{formatRelativeTime(item.updatedAt)}</Text></View><Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 3 }]}>{item.spaceName} · {item.preview}</Text></View>
        <StatusPill label={item.status === "running" ? "Running" : item.status === "attention" ? "Needs you" : "Done"} tone={getStatusTone(item.status)} />
      </Pressable>) : <EmptyState icon="pulse-outline" title="Nothing needs attention" description="Completed and running Agent work will appear here." />}
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
  return <Pressable onPress={onPress} style={{ paddingHorizontal: 12, minHeight: 32, borderRadius: 999, justifyContent: "center", backgroundColor: selected ? theme.colors.accentSoft : theme.colors.surface, borderWidth: 1, borderColor: selected ? theme.colors.accentBorder : theme.colors.border }}><Text style={[typography.caption, { color: selected ? theme.colors.accent : theme.colors.textMuted }]}>{label}</Text></Pressable>;
}
