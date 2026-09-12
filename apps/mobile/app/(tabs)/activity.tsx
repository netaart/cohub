import { useRouter, useScrollToTop } from "expo-router";
import { useRef, useState } from "react";
import { Image, RefreshControl, ScrollView, Text, View } from "react-native";
import { AccountAvatar } from "@/src/components/AccountAvatar";
import { useFloatingTabBarInset } from "@/src/components/FloatingTabBar";
import { TokenHeatmap } from "@/src/components/TokenHeatmap";
import { TaskResultSheet } from "@/src/components/TaskResultSheet";
import { useApp } from "@/src/data/context";
import { taskOutputs, taskTitle } from "@/src/data/activity";
import { useActivity } from "@/src/data/use-activity";
import { useAppTheme, typography } from "@/src/theme";
import { useTranslation } from "@/src/i18n";
import { AppIcon, ConnectionBanner, DataError, EmptyState, LoadingRows, Screen, SectionHeader, StatusPill, TopBar } from "@/src/ui";
import { formatRelativeTime } from "@/src/utils";
import { PressableScale } from "@/src/ui/PressableScale";

export default function ActivityScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const tabBarInset = useFloatingTabBarInset();
  const { connectionState, userUuid } = useApp();
  const { credits, days, works, tasks, loading, refresh } = useActivity();
  const [selection, setSelection] = useState<{ id: string; userUuid: string | null } | null>(null);
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
      <SectionHeader title={t("activity.works.title")} />
      {works.error ? <DataError message={works.error} onRetry={retry} /> : null}
      {works.data ? works.data.length ? works.data.map((work) => <PressableScale key={work.id} accessibilityRole="button" onPress={() => router.push({ pathname: "/work/[appId]", params: { appId: work.id } })} style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.md, padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.colors.border }} pressedStyle={{ backgroundColor: theme.colors.surfacePressed }}>
        <AppIcon name="layers" size={22} color={theme.colors.info} />
        <View style={{ flex: 1, minWidth: 0, gap: theme.spacing.xs }}><Text numberOfLines={2} style={[typography.bodyMedium, { color: theme.colors.text }]}>{work.meta?.title || work.meta?.name || work.slug}</Text><Text style={[typography.micro, { color: theme.colors.textMuted }]}>{work.createdAt ? formatRelativeTime(work.createdAt) : work.slug}</Text></View>
        <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} />
      </PressableScale>) : <EmptyState icon="layers" title={t("activity.works.empty")} /> : !works.error ? <LoadingRows count={2} /> : null}
      <SectionHeader title={t("activity.tasks.title")} />
      {tasks.error ? <DataError message={tasks.error} onRetry={retry} /> : null}
      {tasks.data ? tasks.data.length ? tasks.data.map((task) => {
        const image = taskOutputs(task).find((output) => output.type === "image");
        return <PressableScale key={task.id} accessibilityRole="button" onPress={() => setSelection({ id: task.id, userUuid })} style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.md, padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.colors.border }} pressedStyle={{ backgroundColor: theme.colors.surfacePressed }}>
          {image && image.type === "image" ? <Image source={{ uri: image.url }} style={{ width: 48, height: 48, borderRadius: theme.radius.sm }} /> : <View style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceRaised, borderRadius: theme.radius.sm }}><AppIcon name="file-text" size={22} color={theme.colors.textMuted} /></View>}
          <View style={{ flex: 1, minWidth: 0, gap: theme.spacing.xs }}><Text numberOfLines={2} style={[typography.bodyMedium, { color: theme.colors.text }]}>{taskTitle(task)}</Text><Text style={[typography.micro, { color: theme.colors.textMuted }]}>{formatRelativeTime(task.createdAt)}</Text><StatusPill label={t(task.status === "completed" ? "ui.status.done" : task.status === "failed" ? "ui.status.failed" : task.status === "running" ? "ui.status.running" : "activity.tasks.pending")} tone={task.status === "failed" ? "danger" : task.status === "completed" ? "success" : "warning"} /></View>
          <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} />
        </PressableScale>;
      }) : <EmptyState icon="file-text" title={t("activity.tasks.empty")} /> : !tasks.error ? <LoadingRows count={2} /> : null}
    </ScrollView>
    {selection && selection.userUuid === userUuid ? <TaskResultSheet key={selection.id} taskId={selection.id} onClose={() => setSelection(null)} /> : null}
  </Screen>;
}
