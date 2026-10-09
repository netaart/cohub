import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useApp } from "@/src/data/context";
import type { ConnectionState } from "@/src/data/types";
import { typography, useAppTheme } from "@/src/theme";
import { AppIcon, PrimaryButton, Screen, SectionHeader, StatusPill } from "@/src/ui";
import type { IconName } from "@/src/icons";

function connectionTone(state: ConnectionState): "success" | "warning" | "danger" | "neutral" {
  if (state === "open") return "success";
  if (state === "connecting" || state === "reconnecting") return "warning";
  if (state === "error" || state === "closed") return "danger";
  return "neutral";
}

export default function DebugConnectionScreen() {
  const theme = useAppTheme();
  const { state, connectionState, refreshHome, refreshSessionStatuses } = useApp();
  const [timeline, setTimeline] = useState<{ at: number; value: ConnectionState }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void Promise.resolve().then(() =>
      setTimeline((current) => [{ at: Date.now(), value: connectionState }, ...current].slice(0, 40)),
    );
  }, [connectionState]);

  const restart = useCallback(async () => {
    if (busy) return;
    setBusy("restart");
    try {
      await refreshHome();
      await refreshSessionStatuses(state.sessions);
    } finally {
      setBusy(null);
    }
  }, [busy, refreshHome, refreshSessionStatuses, state.sessions]);

  const views = Object.entries(state.sessionViews);
  const streams = views.filter(([, view]) => view.stream);
  const runningTurns = Object.values(state.sessionLatestTurns).filter((turn) => turn?.status === "running").length;
  const sending = views.filter(([, view]) => view.sending).length;
  const optimistic = views.reduce(
    (total, [, view]) => total + view.messages.filter((message) => message.meta?.optimistic === true).length,
    0,
  );

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: "center", paddingTop: 20, gap: 8 }}>
          <StatusPill label={connectionState} tone={connectionTone(connectionState)} />
          <Text style={[typography.caption, { color: theme.colors.textMuted }]}>
            {state.booting ? "启动中" : state.refreshing ? "刷新中" : "已就绪"}
          </Text>
        </View>

        <SectionHeader title="同步状态" />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          <Row icon="messages" label="会话(列表)" value={String(state.sessions.length)} />
          <Row icon="layers" label="空间" value={String(state.spaces.length)} />
          <Row icon="activity" label="运行中的轮次" value={String(runningTurns)} />
          <Row icon="arrow-up" label="发送中 / 乐观消息" value={`${sending} / ${optimistic}`} />
          <Row icon="list-tree" label="会话分页" value={`hasMore=${state.sessionsHasMore} · cursor=${state.sessionsCursor ? `${state.sessionsCursor.slice(0, 12)}…` : "—"}`} />
          <Row icon="refresh" label="状态请求中" value={String(state.sessionStatusRequests)} />
          <Row icon="wifi" label="lastSyncedAt" value={state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleTimeString() : "—"} />
        </View>

        {(state.error || state.spacesError || state.sessionsError || state.sessionStatusError || state.activityError) ? (
          <>
            <SectionHeader title="错误" />
            <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
              {state.error ? <Row icon="alert" label="error" value={state.error} tone="danger" /> : null}
              {state.spacesError ? <Row icon="alert" label="spaces" value={state.spacesError} tone="danger" /> : null}
              {state.sessionsError ? <Row icon="alert" label="sessions" value={state.sessionsError} tone="danger" /> : null}
              {state.sessionStatusError ? <Row icon="alert" label="status" value={state.sessionStatusError} tone="danger" /> : null}
              {state.activityError ? <Row icon="alert" label="activity" value={state.activityError} tone="danger" /> : null}
            </View>
          </>
        ) : null}

        <SectionHeader title={`活跃流 · ${streams.length}`} />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          {streams.length === 0 ? (
            <Text style={[typography.caption, { color: theme.colors.textMuted, padding: 14 }]}>当前没有正在流式输出的会话</Text>
          ) : streams.map(([sessionId, view]) => (
            <View key={sessionId} style={{ paddingHorizontal: 13, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border, gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <AppIcon name="sync" size={15} color={theme.colors.accent} />
                <Text style={[typography.bodyMedium, { color: theme.colors.text, flex: 1 }]}>{sessionId.slice(0, 8)}</Text>
                <StatusPill label={view.stream?.status ?? "—"} tone={view.stream?.status === "streaming" || view.stream?.status === "pending" ? "warning" : "neutral"} />
              </View>
              <Text style={[typography.micro, { color: theme.colors.textMuted }]}>
                {`turn=${view.stream?.turnId?.slice(0, 8) ?? "—"} · phase=${view.stream?.runtimePhase ?? "—"} · model=${view.stream?.runtimeModel ?? "—"} · blocks=${view.stream?.contentBlocks.length ?? 0} · intermediate=${view.stream?.intermediateMessages.length ?? 0}`}
              </Text>
            </View>
          ))}
        </View>

        <SectionHeader title="连接状态时间线" />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          {timeline.map((entry, index) => (
            <View key={`${entry.at}-${index}`} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 13, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
              <Text style={[typography.micro, { color: theme.colors.textFaint, fontVariant: ["tabular-nums"] }]}>{new Date(entry.at).toLocaleTimeString()}</Text>
              <StatusPill label={entry.value} tone={connectionTone(entry.value)} dot={false} />
            </View>
          ))}
        </View>

        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
          <PrimaryButton label="重新同步 (refreshHome + statuses)" icon="refresh" loading={busy === "restart"} disabled={busy !== null} onPress={() => void restart()} />
        </View>
      </ScrollView>
    </Screen>
  );
}

function Row({ icon, label, value, tone = "default" }: { icon: IconName; label: string; value: string; tone?: "default" | "danger" }) {
  const theme = useAppTheme();
  return (
    <View style={{ minHeight: 52, paddingHorizontal: 13, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 11, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <View style={{ width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceRaised }}>
        <AppIcon name={icon} size={15} color={tone === "danger" ? theme.colors.danger : theme.colors.textMuted} />
      </View>
      <Text style={[typography.caption, { color: theme.colors.textMuted, width: 130 }]}>{label}</Text>
      <Text selectable numberOfLines={3} style={[typography.caption, { color: tone === "danger" ? theme.colors.danger : theme.colors.textSecondary, flex: 1, textAlign: "right" }]}>{value}</Text>
    </View>
  );
}

const styles = {
  group: { marginHorizontal: 16, borderWidth: 1, borderRadius: 14, overflow: "hidden" as const },
} satisfies Record<string, object>;
