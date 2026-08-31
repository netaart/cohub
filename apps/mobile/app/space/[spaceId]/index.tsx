import type { AppRecord, CheckpointRecord, TaskRunRecord } from "@neta-art/cohub";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { AdaptiveSheet, SheetAction } from "@/src/components/AdaptiveSheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionRow } from "@/src/components/SessionRow";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, Avatar, DetailTopBar, IconButton, PrimaryButton, Screen, SectionHeader, StatusPill } from "@/src/ui";
import { displaySpaceName, formatRelativeTime } from "@/src/utils";

type Params = { spaceId?: string | string[] };

type Resources = {
  checkpoints: CheckpointRecord[];
  apps: AppRecord[];
  tasks: TaskRunRecord[];
};

const emptyResources: Resources = { checkpoints: [], apps: [], tasks: [] };

export default function SpaceScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const spaceId = Array.isArray(params.spaceId) ? params.spaceId[0] : params.spaceId;
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { state, client, refreshHome } = useApp();
  const [resources, setResources] = useState<Resources>(emptyResources);
  const [loadingResources, setLoadingResources] = useState(false);
  const [spaceActionsOpen, setSpaceActionsOpen] = useState(false);
  const space = state.spaces.find((item) => item.id === spaceId) ?? null;
  const sessions = useMemo(
    () => state.sessions.filter((session) => session.spaceId === spaceId),
    [spaceId, state.sessions],
  );

  useEffect(() => {
    if (!client || !spaceId) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (active) setLoadingResources(true);
      return Promise.allSettled([
        client.space(spaceId).checkpoints.list({ limit: 5 }),
        client.apps.listBySpace(spaceId),
        client.tasks.list({ spaceId, limit: 8 }),
      ]);
    }).then(([checkpointResult, appResult, taskResult]) => {
      if (!active) return;
      setResources({
        checkpoints: checkpointResult.status === "fulfilled" ? checkpointResult.value.checkpoints : [],
        apps: appResult.status === "fulfilled" ? appResult.value.apps : [],
        tasks: taskResult.status === "fulfilled" ? taskResult.value.runs : [],
      });
    }).finally(() => {
      if (active) setLoadingResources(false);
    });
    return () => { active = false; };
  }, [client, spaceId]);

  if (!space) {
    return <Screen><DetailTopBar title="Space" onBack={() => router.back()} /><View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text style={[typography.body, { color: theme.colors.textMuted }]}>Space unavailable.</Text></View></Screen>;
  }

  const name = displaySpaceName(space);
  const activeTasks = resources.tasks.filter((task) => task.status === "pending" || task.status === "running").length;
  return <Screen>
    <DetailTopBar
      title={name}
      subtitle="Space"
      onBack={() => router.back()}
      actions={<IconButton name="more" label="Space actions" size={40} onPress={() => setSpaceActionsOpen(true)} />}
    />
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={() => void refreshHome()} tintColor={theme.colors.accent} colors={[theme.colors.accent]} />}
    >
    <View style={{ alignItems: "center", paddingHorizontal: 20, paddingTop: 25, paddingBottom: 22 }}>
      <Avatar name={name} uri={space.publicProfile?.avatarUrl} size={70} online={space.status === "running"} />
      <Text style={[typography.title, { color: theme.colors.text, marginTop: 12 }]}>{name}</Text>
      <Text style={[typography.body, { color: theme.colors.textMuted, textAlign: "center", marginTop: 5, maxWidth: 320 }]}>{space.description || "A shared workspace for people and Agents."}</Text>
    </View>
    <View style={{ flexDirection: "row", paddingHorizontal: 16, gap: 10 }}>
      <SpaceMetric icon="messages" label="Chats" value={String(sessions.length)} />
      <SpaceMetric icon="rocket" label="Works" value={String(resources.apps.length)} />
      <SpaceMetric icon="activity" label="Running" value={String(activeTasks)} />
    </View>
    <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 16, marginTop: 18 }}>
      <PrimaryButton label="New Chat" icon="plus" onPress={() => router.push({ pathname: "/new-chat", params: { spaceId: space.id } })} style={{ flex: 1 }} />
      <Pressable accessibilityRole="button" accessibilityLabel="Open Files" onPress={() => router.push({ pathname: "/space/[spaceId]/files", params: { spaceId: space.id } })} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ minHeight: 46, width: 52, borderRadius: 14, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface })}><AppIcon name="folder-open" size={19} color={theme.colors.textSecondary} /></Pressable>
    </View>

    <SectionHeader title="Chats" action="New" onAction={() => router.push({ pathname: "/new-chat", params: { spaceId: space.id } })} />
    <View>{sessions.length > 0 ? sessions.slice(0, 8).map((session) => <SessionRow key={session.id} session={{ ...session, space: session.space ?? { id: space.id, name, slug: space.slug, publicProfile: space.publicProfile ?? null } }} onPress={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: session.id } })} />) : <ResourceEmpty text="No Chats in this Space yet." />}</View>

    <SectionHeader title="Works" />
    <View>{resources.apps.length > 0 ? resources.apps.slice(0, 6).map((app) => <ResourceRow key={app.id} icon="rocket" title={app.meta?.title || app.meta?.name || app.slug} subtitle={`${app.targetType} · version ${app.latestVersion}`} trailing={<StatusPill label={app.status === "published" ? "Published" : "Disabled"} tone={app.status === "published" ? "success" : "neutral"} />} onPress={() => router.push({ pathname: "/work/[appId]", params: { appId: app.id } })} />) : <ResourceEmpty text={loadingResources ? "Loading Works…" : "No published Works yet."} />}</View>

    <SectionHeader title="Recent Saves" />
    <View>{resources.checkpoints.length > 0 ? resources.checkpoints.map((checkpoint) => <ResourceRow key={checkpoint.id} icon="bookmark" title={checkpoint.description || `Save ${checkpoint.commitHash.slice(0, 8)}`} subtitle={`${formatRelativeTime(checkpoint.createdAt)} · ${checkpoint.commitHash.slice(0, 8)}`} />) : <ResourceEmpty text={loadingResources ? "Loading Saves…" : "No Saves yet."} />}</View>

    <SectionHeader title="Task Runs" />
    <View style={{ paddingBottom: 24 }}>{resources.tasks.length > 0 ? resources.tasks.map((task) => <ResourceRow key={task.id} icon={task.status === "running" ? "sync" : task.status === "failed" ? "alert" : "check-circle"} title={task.taskType.replaceAll("_", " ")} subtitle={task.errorMessage || `${formatRelativeTime(task.updatedAt)} · attempt ${task.attemptCount}`} trailing={<StatusPill label={task.status} tone={task.status === "failed" ? "danger" : task.status === "running" || task.status === "pending" ? "warning" : "success"} />} onPress={task.sessionId ? () => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: task.sessionId! } }) : undefined} />) : <ResourceEmpty text={loadingResources ? "Loading task runs…" : "No recent task runs."} />}</View>
    </ScrollView>
    <AdaptiveSheet
      visible={spaceActionsOpen}
      title={name}
      subtitle="Space actions"
      onClose={() => setSpaceActionsOpen(false)}
      scrollable={false}
      testID="space-actions-sheet"
    >
      <Text style={[typography.body, { color: theme.colors.textSecondary }]}>
        {space.description || "A shared workspace for people and Agents."}
      </Text>
      <SheetAction
        icon="messages"
        title="New Chat"
        detail="Start a focused thread in this Space"
        onPress={() => {
          setSpaceActionsOpen(false);
          router.push({ pathname: "/new-chat", params: { spaceId: space.id } });
        }}
      />
      <SheetAction
        icon="folder-open"
        title="Open Files"
        detail="Browse files in this Space"
        onPress={() => {
          setSpaceActionsOpen(false);
          router.push({ pathname: "/space/[spaceId]/files", params: { spaceId: space.id } });
        }}
      />
    </AdaptiveSheet>
  </Screen>;
}

function SpaceMetric({ icon, label, value }: { icon: React.ComponentProps<typeof AppIcon>["name"]; label: string; value: string }) {
  const theme = useAppTheme();
  return <View style={{ flex: 1, minHeight: 75, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 13, backgroundColor: theme.colors.surface, padding: 10 }}><AppIcon name={icon} size={16} color={theme.colors.accent} /><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, marginTop: 8 }]}>{value}</Text><Text style={[typography.micro, { color: theme.colors.textMuted, marginTop: 2 }]}>{label}</Text></View>;
}

function ResourceRow({ icon, title, subtitle, trailing, onPress }: { icon: React.ComponentProps<typeof AppIcon>["name"]; title: string; subtitle: string; trailing?: React.ReactNode; onPress?: () => void }) {
  const theme = useAppTheme();
  const content = <View style={{ minHeight: 62, flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 16 }}><View style={{ width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface }}><AppIcon name={icon} size={17} color={theme.colors.textMuted} /></View><View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, textTransform: "capitalize" }]}>{title}</Text><Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>{subtitle}</Text></View>{trailing}{onPress ? <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} /> : null}</View>;
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}>{content}</Pressable> : content;
}

function ResourceEmpty({ text }: { text: string }) {
  const theme = useAppTheme();
  return <Text style={[typography.body, { color: theme.colors.textMuted, paddingHorizontal: 16, paddingVertical: 12 }]}>{text}</Text>;
}
