import type { GenerationContentBlock, TaskRunDetailResponse } from "@neta-art/cohub";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { useApp } from "@/src/data/context";
import { useSyncScope } from "@/src/data/use-sync-scope";
import { useSpaceRealtime } from "@/src/data/use-space-realtime";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, LoadingRows, Screen, StatusPill, TopBar } from "@/src/ui";
import { formatRelativeTime } from "@/src/utils";

export default function TaskScreen() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>();
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const { client } = useApp();
  const [detail, setDetail] = useState<TaskRunDetailResponse | null>(null);
  useSpaceRealtime(detail?.run.spaceId ? [detail.run.spaceId] : []);
  const [error, setError] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const generation = useRef(0);
  
  // Memoize expensive JSON stringification and limit size
  const jsonString = useMemo(() => {
    if (!detail?.run) return "";
    try {
      const cleaned = JSON.parse(JSON.stringify(detail.run, (_key, value) => {
        // Skip very large fields to prevent performance issues
        if (typeof value === "string" && value.length > 10000) {
          return `[Large string: ${value.length} chars]`;
        }
        // Limit array length
        if (Array.isArray(value) && value.length > 100) {
          return [...value.slice(0, 100), `[...${value.length - 100} more items]`];
        }
        return value;
      }));
      return JSON.stringify(cleaned, null, 2);
    } catch {
      return "[Unable to serialize]";
    }
  }, [detail]);
  useEffect(() => () => { generation.current += 1; }, [client, taskId]);
  useSyncScope(`task:${taskId}`, async () => {
    if (!client || !taskId) return;
    const token = generation.current;
    try {
      const result = await client.tasks.get(taskId);
      if (token !== generation.current) return;
      setDetail(result);
      setError(null);
    } catch (caught) {
      if (token === generation.current) setError(caught instanceof Error ? caught.message : t("task.error"));
      throw caught;
    }
  }, !detail || detail.run.status === "running" || detail.run.status === "pending" ? 5_000 : 60_000, Boolean(taskId));
  const output = generationOutput(detail?.run.result);
  const run = detail?.run;
  
  return <Screen>
    <TopBar title={t("task.title")} onBack={() => router.back()} />
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      {error ? <Text style={[typography.body, { color: theme.colors.danger }]}>{error}</Text> : !detail ? <LoadingRows count={4} /> : (
        <>
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{run?.taskType.replaceAll("_", " ")}</Text>
              <StatusPill 
                label={run?.status ?? "unknown"} 
                tone={run?.status === "failed" ? "danger" : run?.status === "running" || run?.status === "pending" ? "warning" : "success"} 
              />
            </View>
            
            <View style={{ gap: 8 }}>
              <InfoRow icon="clock" label={t("task.created")} value={formatRelativeTime(run?.createdAt ?? "")} />
              <InfoRow icon="clock" label={t("task.updated")} value={formatRelativeTime(run?.updatedAt ?? "")} />
              <InfoRow icon="activity" label={t("task.attempts")} value={String(run?.attemptCount ?? 0)} />
              {run?.sessionId && <InfoRow icon="message-square" label={t("task.session")} value={run.sessionId.slice(0, 8)} />}
              {run?.errorMessage && <InfoRow icon="alert" label={t("task.error")} value={run.errorMessage} valueColor={theme.colors.danger} />}
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={() => setShowJson(!showJson)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              padding: 12,
              borderRadius: 10,
              backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface,
            })}
          >
            <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{t("task.showJson")}</Text>
            <AppIcon name={showJson ? "chevron-up" : "chevron-down"} size={16} color={theme.colors.textMuted} />
          </Pressable>

          {showJson && run && (
            <ScrollView horizontal style={{ maxHeight: 400 }}>
              <View style={{ padding: 12, borderRadius: 10, backgroundColor: theme.colors.surfaceRaised }}>
                <Text selectable style={[typography.caption, { color: theme.colors.text, fontSize: 11, lineHeight: 16, fontFamily: "monospace" }]}>
                  {jsonString}
                </Text>
              </View>
            </ScrollView>
          )}

          {output.length > 0 && (
            <View style={{ gap: 12, marginTop: 8 }}>
              <Text style={[typography.heading, { color: theme.colors.text }]}>{t("task.output")}</Text>
              {output.map((block, index) => <GenerationBlock key={index} block={block} />)}
            </View>
          )}

          {output.length === 0 && !run?.errorMessage && run?.status === "completed" && (
            <Text style={[typography.body, { color: theme.colors.textMuted }]}>{t("task.noOutput")}</Text>
          )}
        </>
      )}
    </ScrollView>
  </Screen>;
}
function InfoRow({ icon, label, value, valueColor }: { icon: React.ComponentProps<typeof AppIcon>["name"]; label: string; value: string; valueColor?: string }) {
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <AppIcon name={icon} size={14} color={theme.colors.textMuted} />
      <Text style={[typography.caption, { color: theme.colors.textMuted, minWidth: 70 }]}>{label}</Text>
      <Text selectable style={[typography.caption, { color: valueColor ?? theme.colors.text, flex: 1 }]}>{value}</Text>
    </View>
  );
}

function generationOutput(result: unknown): GenerationContentBlock[] { if (!result || typeof result !== "object" || !Array.isArray((result as { output?: unknown }).output)) return []; return (result as { output: GenerationContentBlock[] }).output; }
function GenerationBlock({ block }: { block: GenerationContentBlock }) { const theme = useAppTheme(); if (block.type === "text") return <Text selectable style={[typography.body, { color: theme.colors.text, lineHeight: 24 }]}>{block.text}</Text>; const source = block.source as unknown as { url?: string; data?: string; mimeType?: string }; const uri = source.url ?? (source.data && source.mimeType ? `data:${source.mimeType};base64,${source.data}` : null); return uri ? <Image accessibilityLabel={`${block.type} output`} source={{ uri }} resizeMode="contain" style={{ width: "100%", height: 320, backgroundColor: theme.colors.surfaceRaised }} /> : <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{block.type}</Text>; }
