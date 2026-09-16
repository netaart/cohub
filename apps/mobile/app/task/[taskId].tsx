import type { GenerationContentBlock, TaskRunDetailResponse } from "@neta-art/cohub";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Image, ScrollView, Text } from "react-native";
import { useApp } from "@/src/data/context";
import { useSyncScope } from "@/src/data/use-sync-scope";
import { useSpaceRealtime } from "@/src/data/use-space-realtime";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { LoadingRows, Screen, TopBar } from "@/src/ui";

export default function TaskScreen() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>();
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const { client } = useApp();
  const [detail, setDetail] = useState<TaskRunDetailResponse | null>(null);
  useSpaceRealtime(detail?.run.spaceId ? [detail.run.spaceId] : []);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
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
  return <Screen><TopBar title={t("task.title")} onBack={() => router.back()} /><ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>{error ? <Text style={[typography.body, { color: theme.colors.danger }]}>{error}</Text> : !detail ? <LoadingRows count={4} /> : output.length === 0 ? <Text style={[typography.body, { color: theme.colors.textMuted }]}>{t("task.noOutput")}</Text> : output.map((block, index) => <GenerationBlock key={index} block={block} />)}</ScrollView></Screen>;
}
function generationOutput(result: unknown): GenerationContentBlock[] { if (!result || typeof result !== "object" || !Array.isArray((result as { output?: unknown }).output)) return []; return (result as { output: GenerationContentBlock[] }).output; }
function GenerationBlock({ block }: { block: GenerationContentBlock }) { const theme = useAppTheme(); if (block.type === "text") return <Text selectable style={[typography.body, { color: theme.colors.text, lineHeight: 24 }]}>{block.text}</Text>; const source = block.source as unknown as { url?: string; data?: string; mimeType?: string }; const uri = source.url ?? (source.data && source.mimeType ? `data:${source.mimeType};base64,${source.data}` : null); return uri ? <Image accessibilityLabel={`${block.type} output`} source={{ uri }} resizeMode="contain" style={{ width: "100%", height: 320, backgroundColor: theme.colors.surfaceRaised }} /> : <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{block.type}</Text>; }
