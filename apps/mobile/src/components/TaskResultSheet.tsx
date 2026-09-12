import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { taskOutputs, taskTitle } from "@/src/data/activity";
import { useTaskResult } from "@/src/data/use-activity";
import { setImageViewerPayload } from "@/src/data/image-viewer";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { DataError, LoadingRows, PrimaryButton } from "@/src/ui";

export function TaskResultSheet({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { task, error, retry } = useTaskResult(taskId);
  const [openError, setOpenError] = useState<string | null>(null);
  const outputs = task ? taskOutputs(task) : [];
  const openMedia = async (url: string) => {
    try { await WebBrowser.openBrowserAsync(url); } catch (caught) { setOpenError(caught instanceof Error ? caught.message : t("work.error")); }
  };
  return <AdaptiveSheet visible title={task ? taskTitle(task) : t("activity.tasks.title")} onClose={onClose} testID="activity-task-result">
    {error ? <DataError message={error} onRetry={retry} /> : !task ? <LoadingRows count={3} /> : <View style={{ gap: theme.spacing.lg }}>
      {task.errorMessage ? <Text selectable style={[typography.body, { color: theme.colors.danger }]}>{task.errorMessage}</Text> : null}
      {outputs.map((output, index) => output.type === "text" ? <Text key={index} selectable style={[typography.body, { color: theme.colors.text }]}>{output.text}</Text> : output.type === "image" ? <Pressable key={index} accessibilityRole="button" accessibilityLabel={t("activity.tasks.openImage")} onPress={() => {
        setImageViewerPayload({ uris: [output.url], index: 0 });
        onClose();
        router.push("/image-viewer");
      }} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}><Image source={{ uri: output.url }} resizeMode="contain" style={{ width: "100%", aspectRatio: 1, backgroundColor: theme.colors.surfaceRaised, borderRadius: theme.radius.sm }} onError={() => setOpenError(t("activity.tasks.mediaError"))} /></Pressable> : <PrimaryButton key={index} icon="external-link" label={t(output.type === "video" ? "activity.tasks.openVideo" : "activity.tasks.openAudio")} onPress={() => void openMedia(output.url)} />)}
      {outputs.length === 0 && !task.errorMessage ? <Text style={[typography.body, { color: theme.colors.textMuted }]}>{t(task.status === "pending" || task.status === "running" ? "activity.tasks.processing" : "activity.tasks.noPreview")}</Text> : null}
      {task.status === "pending" || task.status === "running" ? <PrimaryButton label={t("activity.refresh")} icon="sync" onPress={retry} /> : null}
      {openError ? <Text accessibilityRole="alert" style={[typography.caption, { color: theme.colors.danger }]}>{openError}</Text> : null}
    </View>}
  </AdaptiveSheet>;
}
