import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useApp } from "@/src/data/context";
import { cacheStats, hydrateHome, type CacheStats } from "@/src/data/local-db";
import type { SpaceRecord, UserSessionListItem } from "@neta-art/cohub";
import { typography, useAppTheme } from "@/src/theme";
import { AppIcon, PrimaryButton, Screen, SectionHeader } from "@/src/ui";
import { displaySessionTitle, formatRelativeTime } from "@/src/utils";

const LIST_LIMIT = 50;

export default function DebugCacheScreen() {
  const theme = useAppTheme();
  const { userUuid, clearCache } = useApp();
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [spaces, setSpaces] = useState<SpaceRecord[]>([]);
  const [sessions, setSessions] = useState<UserSessionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextStats, home] = await Promise.all([cacheStats(userUuid), hydrateHome(userUuid)]);
      setStats(nextStats);
      setSpaces(home.spaces);
      setSessions(home.sessions);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取缓存失败");
    } finally {
      setLoading(false);
    }
  }, [userUuid]);

  useEffect(() => {
    void Promise.resolve().then(() => load());
  }, [load]);

  const clear = useCallback(async () => {
    if (clearing) return;
    setClearing(true);
    setError(null);
    try {
      await clearCache();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "清空缓存失败");
    } finally {
      setClearing(false);
    }
  }, [clearCache, clearing, load]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <SectionHeader title="当前用户" />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          <Row icon="fingerprint" label="user_key" value={userUuid} />
          <Row icon="info" label="数据库" value="cohub-mobile.db" />
        </View>

        <SectionHeader title="行数" />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          {loading && !stats ? (
            <View style={{ padding: 20, alignItems: "center" }}>
              <ActivityIndicator size="small" color={theme.colors.accent} />
            </View>
          ) : (
            <>
              <Metric icon="layers" label="spaces" value={stats?.spaces ?? 0} />
              <Metric icon="messages" label="sessions" value={stats?.sessions ?? 0} />
              <Metric icon="file-text" label="messages" value={stats?.messages ?? 0} />
              <Metric icon="bookmark" label="read states" value={stats?.readStates ?? 0} />
            </>
          )}
          {error ? <Row icon="alert" label="错误" value={error} tone="danger" /> : null}
        </View>

        <View style={{ flexDirection: "row", gap: 10, marginHorizontal: 16, marginTop: 14 }}>
          <PrimaryButton label="刷新" icon="refresh" loading={loading} disabled={clearing} onPress={() => void load()} style={{ flex: 1 }} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="清空本地缓存"
            disabled={clearing}
            onPress={() => void clear()}
            style={({ pressed }) => ({ minHeight: 46, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.danger, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.dangerSoft : "transparent", opacity: clearing ? 0.55 : 1, flex: 1 })}
          >
            <Text style={[typography.bodyMedium, { color: theme.colors.danger }]}>{clearing ? "清空中…" : "清空缓存"}</Text>
          </Pressable>
        </View>
        <Text style={[typography.caption, { color: theme.colors.textMuted, marginHorizontal: 16, marginTop: 10 }]}>
          清空只删当前用户的本地副本；下次进入会重新从服务端填充。用来验证 cache-first 与登出清理。
        </Text>

        <SectionHeader title={`缓存空间 · ${spaces.length}`} />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          {spaces.length === 0 ? <Empty text="没有缓存空间" /> : spaces.slice(0, LIST_LIMIT).map((space) => (
            <Row key={space.id} icon="layers" label={space.name?.trim() || space.title?.trim() || "—"} value={`${space.id.slice(0, 8)} · ${formatRelativeTime(space.updatedAt)}`} />
          ))}
          {spaces.length > LIST_LIMIT ? <Empty text={`还有 ${spaces.length - LIST_LIMIT} 个…`} /> : null}
        </View>

        <SectionHeader title={`缓存会话 · ${sessions.length}`} />
        <View style={[styles.group, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          {sessions.length === 0 ? <Empty text="没有缓存会话" /> : sessions.slice(0, LIST_LIMIT).map((session) => (
            <Row key={session.id} icon="messages" label={displaySessionTitle(session)} value={`${session.id.slice(0, 8)} · ${formatRelativeTime(session.lastMessageAt ?? session.updatedAt)}`} />
          ))}
          {sessions.length > LIST_LIMIT ? <Empty text={`还有 ${sessions.length - LIST_LIMIT} 个…`} /> : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

function Metric({ icon, label, value }: { icon: React.ComponentProps<typeof AppIcon>["name"]; label: string; value: number }) {
  const theme = useAppTheme();
  return (
    <View style={{ minHeight: 58, paddingHorizontal: 13, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 11, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <View style={{ width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceRaised }}>
        <AppIcon name={icon} size={16} color={theme.colors.accent} />
      </View>
      <Text style={[typography.caption, { color: theme.colors.textMuted, flex: 1 }]}>{label}</Text>
      <Text style={[typography.heading, { color: theme.colors.text }]}>{value}</Text>
    </View>
  );
}

function Row({ icon, label, value, tone = "default" }: { icon: React.ComponentProps<typeof AppIcon>["name"]; label: string; value: string; tone?: "default" | "danger" }) {
  const theme = useAppTheme();
  const color = tone === "danger" ? theme.colors.danger : theme.colors.textSecondary;
  return (
    <View style={{ minHeight: 54, paddingHorizontal: 13, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 11, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <View style={{ width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceRaised }}>
        <AppIcon name={icon} size={15} color={tone === "danger" ? theme.colors.danger : theme.colors.textMuted} />
      </View>
      <Text numberOfLines={1} style={[typography.bodyMedium, { color: tone === "danger" ? theme.colors.danger : theme.colors.text, flex: 1 }]}>{label}</Text>
      <Text selectable numberOfLines={2} style={[typography.micro, { color, maxWidth: "48%", textAlign: "right" }]}>{value}</Text>
    </View>
  );
}

function Empty({ text }: { text: string }) {
  const theme = useAppTheme();
  return <Text style={[typography.caption, { color: theme.colors.textMuted, padding: 14 }]}>{text}</Text>;
}

const styles = {
  group: { marginHorizontal: 16, borderWidth: 1, borderRadius: 14, overflow: "hidden" as const },
} satisfies Record<string, object>;
