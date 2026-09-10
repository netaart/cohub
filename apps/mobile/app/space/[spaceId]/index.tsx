import type { AppRecord, CheckpointRecord, SpaceRecord, TaskRunRecord, UserSessionListItem } from "@neta-art/cohub";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { AdaptiveSheet, SheetAction } from "@/src/components/AdaptiveSheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionRow } from "@/src/components/SessionRow";
import { SpacePanels, type SpacePanel } from "@/src/components/SpacePanels";
import { useApp } from "@/src/data/context";
import { publishSpaceSessionCount, SPACE_SESSION_COUNT_PAGE_SIZE } from "@/src/data/space-session-counts";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, Avatar, DetailTopBar, IconButton, PrimaryButton, Screen, SectionHeader, StatusPill } from "@/src/ui";
import { displaySpaceName, formatRelativeTime, sortByRecent } from "@/src/utils";

type Params = { spaceId?: string | string[] };

type Resources = {
  checkpoints: CheckpointRecord[];
  apps: AppRecord[];
  tasks: TaskRunRecord[];
};

type ResourceFailures = Record<"checkpoints" | "apps" | "tasks", boolean>;

const emptyResources: Resources = { checkpoints: [], apps: [], tasks: [] };
const noResourceFailures: ResourceFailures = { checkpoints: false, apps: false, tasks: false };
const SPACE_REFRESH_INTERVAL_MS = 60_000;

export default function SpaceScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const spaceId = Array.isArray(params.spaceId) ? params.spaceId[0] : params.spaceId;
  const theme = useAppTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { state, client, refreshHome, refreshSessionStatuses, refreshSpacePin, toggleSpacePin, upsertSpace } = useApp();
  const [loadedSpace, setLoadedSpace] = useState<SpaceRecord | null>(null);
  const [spaceLoading, setSpaceLoading] = useState(true);
  const [spaceError, setSpaceError] = useState<string | null>(null);
  const [resources, setResources] = useState<Resources>(emptyResources);
  const [loadingResources, setLoadingResources] = useState(true);
  const [resourceFailures, setResourceFailures] = useState<ResourceFailures>(noResourceFailures);
  const [spaceSessions, setSpaceSessions] = useState<UserSessionListItem[]>([]);
  const [spaceSessionsHasMore, setSpaceSessionsHasMore] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsFailed, setSessionsFailed] = useState(false);
  const [pageRefreshing, setPageRefreshing] = useState(false);
  const [spaceActionsOpen, setSpaceActionsOpen] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<SpacePanel | null>(null);
  const spaceRefreshAtRef = useRef<{ spaceId: string; at: number } | null>(null);
  const spaceRefreshInFlightRef = useRef<{ spaceId: string; token: number } | null>(null);
  const spaceRefreshTokenRef = useRef(0);
  const resourcesRefreshAtRef = useRef(0);
  const resourcesRequestRef = useRef(0);
  const sessionsRefreshAtRef = useRef(0);
  const sessionsRequestRef = useRef(0);
  const cachedSpace = state.spaces.find((item) => item.id === spaceId) ?? null;
  const cachedSpaceRef = useRef<SpaceRecord | null>(cachedSpace);
  useEffect(() => {
    cachedSpaceRef.current = cachedSpace;
  }, [cachedSpace]);
  const space = cachedSpace ?? (loadedSpace?.id === spaceId ? loadedSpace : null);
  const sessions = useMemo(() => {
    const byId = new Map<string, UserSessionListItem>();
    for (const session of state.sessions) {
      if (session.spaceId === spaceId) byId.set(session.id, session);
    }
    // The page fetches its own page of Chats; cached entries still win when newer.
    for (const session of spaceSessions) {
      const previous = byId.get(session.id);
      byId.set(session.id, previous ? preferRecentSession(previous, session) : session);
    }
    return sortByRecent([...byId.values()]);
  }, [spaceId, spaceSessions, state.sessions]);

  const loadSpace = useCallback(async (options: { force?: boolean } = {}) => {
    if (!client || !spaceId) return;
    if (spaceRefreshInFlightRef.current?.spaceId === spaceId) return;
    const lastRefresh = spaceRefreshAtRef.current;
    if (!options.force && cachedSpaceRef.current && lastRefresh?.spaceId === spaceId && Date.now() - lastRefresh.at < SPACE_REFRESH_INTERVAL_MS) return;
    const requestToken = spaceRefreshTokenRef.current + 1;
    spaceRefreshTokenRef.current = requestToken;
    spaceRefreshInFlightRef.current = { spaceId, token: requestToken };
    setSpaceLoading(true);
    setSpaceError(null);
    // Pin state comes from a private label endpoint; without it the Space remains usable.
    const [spaceResult, pinResult] = await Promise.allSettled([
      client.spaces.get(spaceId),
      refreshSpacePin(spaceId),
    ]);
    if (spaceRefreshInFlightRef.current?.token !== requestToken) return;
    spaceRefreshInFlightRef.current = null;
    setSpaceLoading(false);
    if (spaceResult.status === "rejected") {
      setSpaceError(spaceResult.reason instanceof Error && spaceResult.reason.message.trim() ? spaceResult.reason.message : t("space.unavailable"));
      return;
    }
    spaceRefreshAtRef.current = { spaceId, at: Date.now() };
    const pinned = pinResult.status === "fulfilled" ? pinResult.value : null;
    const resolved = pinned === null ? spaceResult.value : { ...spaceResult.value, isPinned: pinned };
    setLoadedSpace(resolved);
    upsertSpace(resolved);
  }, [client, refreshSpacePin, spaceId, t, upsertSpace]);

  const loadResources = useCallback(async (options: { force?: boolean } = {}) => {
    if (!client || !spaceId) return;
    if (!options.force && Date.now() - resourcesRefreshAtRef.current < SPACE_REFRESH_INTERVAL_MS) return;
    const requestToken = ++resourcesRequestRef.current;
    setLoadingResources(true);
    const [checkpointResult, appResult, taskResult] = await Promise.allSettled([
      client.space(spaceId).checkpoints.list({ limit: 5 }),
      client.apps.listBySpace(spaceId),
      client.tasks.list({ spaceId, limit: 8 }),
    ]);
    if (resourcesRequestRef.current !== requestToken) return;
    resourcesRefreshAtRef.current = Date.now();
    // Settled sections replace their data; failed ones keep what is already on screen.
    setResources((current) => ({
      checkpoints: checkpointResult.status === "fulfilled" ? checkpointResult.value.checkpoints : current.checkpoints,
      apps: appResult.status === "fulfilled" ? appResult.value.apps : current.apps,
      tasks: taskResult.status === "fulfilled" ? taskResult.value.runs : current.tasks,
    }));
    setResourceFailures({
      checkpoints: checkpointResult.status === "rejected",
      apps: appResult.status === "rejected",
      tasks: taskResult.status === "rejected",
    });
    setLoadingResources(false);
  }, [client, spaceId]);

  const loadSessions = useCallback(async (options: { force?: boolean } = {}) => {
    if (!client || !spaceId) return;
    if (!options.force && Date.now() - sessionsRefreshAtRef.current < SPACE_REFRESH_INTERVAL_MS) return;
    const requestToken = ++sessionsRequestRef.current;
    setSessionsLoading(true);
    try {
      const response = await client.space(spaceId).sessions.list({ limit: SPACE_SESSION_COUNT_PAGE_SIZE });
      if (sessionsRequestRef.current !== requestToken) return;
      sessionsRefreshAtRef.current = Date.now();
      const hasMore = Boolean(response.pageInfo?.hasMore);
      setSpaceSessions(response.sessions);
      setSpaceSessionsHasMore(hasMore);
      setSessionsFailed(false);
      publishSpaceSessionCount(client, spaceId, response.sessions.length, hasMore);
      void refreshSessionStatuses(response.sessions);
    } catch {
      if (sessionsRequestRef.current !== requestToken) return;
      sessionsRefreshAtRef.current = Date.now();
      setSessionsFailed(true);
    } finally {
      if (sessionsRequestRef.current === requestToken) setSessionsLoading(false);
    }
  }, [client, refreshSessionStatuses, spaceId]);

  const reloadDetails = useCallback(() => Promise.allSettled([
    loadResources({ force: true }),
    loadSessions({ force: true }),
  ]), [loadResources, loadSessions]);

  const refreshPage = useCallback(async () => {
    setPageRefreshing(true);
    try {
      await Promise.allSettled([refreshHome(), reloadDetails()]);
    } finally {
      setPageRefreshing(false);
    }
  }, [refreshHome, reloadDetails]);

  useFocusEffect(useCallback(() => {
    void loadSpace();
    void loadResources();
    void loadSessions();
    return () => {
      // A response that outlives this focus must not write over fresher state.
      resourcesRequestRef.current += 1;
      sessionsRequestRef.current += 1;
    };
  }, [loadResources, loadSessions, loadSpace]));

  if (!space) {
    const opening = Boolean(spaceId) && (state.booting || !client || spaceLoading);
    return <Screen>
      <DetailTopBar title={t("space.title")} onBack={() => router.back()} />
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        {opening
          ? <Text style={[typography.body, { color: theme.colors.textMuted }]}>{t("space.opening")}</Text>
          : <><Text style={[typography.body, { color: theme.colors.textMuted, textAlign: "center" }]}>{t("space.unavailable")}</Text>{spaceError ? <Text selectable style={[typography.caption, { color: theme.colors.danger, textAlign: "center", marginTop: 8 }]}>{spaceError}</Text> : null}{spaceId ? <PrimaryButton label={t("common.retry")} icon="refresh" onPress={() => void loadSpace({ force: true })} style={{ marginTop: 16 }} /> : null}</>}
      </View>
    </Screen>;
  }

  const name = displaySpaceName(space);
  const togglePin = async () => {
    if (pinning) return;
    setPinning(true);
    setPinError(null);
    try {
      await toggleSpacePin(space.id);
    } catch (error) {
      setPinError(error instanceof Error ? error.message : t("spaces.pin.error"));
    } finally {
      setPinning(false);
    }
  };
  const activeTasks = resources.tasks.filter((task) => task.status === "pending" || task.status === "running").length;
  const detailsFailed = resourceFailures.checkpoints || resourceFailures.apps || resourceFailures.tasks || sessionsFailed;
  return <Screen>
    <SpacePanels
      key={space.id}
      spaceId={space.id}
      spaceName={name}
      sessions={sessions}
      client={client}
      activePanel={activePanel}
      onActivePanelChange={setActivePanel}
      onOpenSession={(sessionId, target) => router.push({ pathname: "/chat/[sessionId]", params: { sessionId, ...(target?.turn != null ? { turn: String(target.turn) } : {}), ...(target?.turnId ? { turnId: target.turnId } : {}) } })}
      onNewChat={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: "new", spaceId: space.id } })}
      onOpenFile={(path) => router.push({ pathname: "/space/[spaceId]/file", params: { spaceId: space.id, path } })}
      onOpenFilesPage={() => router.push({ pathname: "/space/[spaceId]/files", params: { spaceId: space.id } })}
    >
      <View style={{ flex: 1 }}>
    <DetailTopBar
      title={name}
      subtitle={t("space.subtitle")}
      onBack={() => router.back()}
      actions={<><IconButton name="messages" label={t("chat.actions.openChats")} size={38} onPress={() => setActivePanel("chat")} /><IconButton name={space.isPinned ? "pin-off" : "pin"} label={space.isPinned ? t("space.unpin") : t("space.pin")} size={38} tone={space.isPinned ? "accent" : "default"} disabled={pinning} onPress={() => void togglePin()} /><IconButton name="more" label={t("space.actions")} size={38} onPress={() => setSpaceActionsOpen(true)} /></>}
    />
    {pinError ? <Pressable accessibilityRole="button" accessibilityLabel={t("space.pin.dismiss")} onPress={() => setPinError(null)} style={{ marginHorizontal: 16, marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: theme.colors.dangerSoft }}><Text style={[typography.caption, { color: theme.colors.danger }]}>{pinError}</Text></Pressable> : null}
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      refreshControl={<RefreshControl refreshing={state.refreshing || pageRefreshing} onRefresh={() => void refreshPage()} tintColor={theme.colors.accent} colors={[theme.colors.accent]} />}
    >
    <View style={{ alignItems: "center", paddingHorizontal: 20, paddingTop: 25, paddingBottom: 22 }}>
      <Avatar name={name} uri={space.publicProfile?.avatarUrl} size={70} online={space.status === "running"} />
      <Text style={[typography.title, { color: theme.colors.text, marginTop: 12 }]}>{name}</Text>
      <Text style={[typography.body, { color: theme.colors.textMuted, textAlign: "center", marginTop: 5, maxWidth: 320 }]}>{space.description || t("space.descriptionFallback")}</Text>
    </View>
    <View style={{ flexDirection: "row", paddingHorizontal: 16, gap: 10 }}>
      <SpaceMetric icon="messages" label={t("space.metric.chats")} value={`${sessions.length}${spaceSessionsHasMore ? "+" : ""}`} />
      <SpaceMetric icon="rocket" label={t("space.metric.works")} value={String(resources.apps.length)} />
      <SpaceMetric icon="activity" label={t("space.metric.running")} value={String(activeTasks)} />
    </View>
    <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 16, marginTop: 18 }}>
      <PrimaryButton label={t("space.newChat")} icon="plus" onPress={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: "new", spaceId: space.id } })} style={{ flex: 1 }} />
      <Pressable accessibilityRole="button" accessibilityLabel={t("space.openFilesPanel")} onPress={() => setActivePanel("files")} style={({ pressed }) => ({ minHeight: 46, width: 52, borderRadius: 14, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface })}><AppIcon name="folder-open" size={19} color={theme.colors.textSecondary} /></Pressable>
    </View>
    {detailsFailed ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, marginTop: 12 }}><Text selectable style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{t("space.resourcesFailed")}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("space.resourcesRetry")} disabled={loadingResources || sessionsLoading} onPress={() => void reloadDetails()} hitSlop={8} style={({ pressed }) => ({ opacity: loadingResources || sessionsLoading ? 0.5 : pressed ? 0.6 : 1 })}><Text style={[typography.micro, { color: theme.colors.accent }]}>{t("common.retry")}</Text></Pressable></View> : null}

    <SectionHeader title={t("space.section.chats")} action={t("space.section.new")} onAction={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: "new", spaceId: space.id } })} />
    <View>{sessions.length > 0 ? sessions.slice(0, 8).map((session) => <SessionRow key={session.id} session={{ ...session, space: session.space ?? { id: space.id, name, slug: space.slug, publicProfile: space.publicProfile ?? null } }} onPress={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: session.id } })} />) : <ResourceEmpty text={sessionsLoading ? t("space.empty.chatsLoading") : sessionsFailed ? t("space.empty.loadFailed") : t("space.empty.chats")} />}</View>

    <SectionHeader title={t("space.section.works")} />
    <View>{resources.apps.length > 0 ? resources.apps.slice(0, 6).map((app) => <ResourceRow key={app.id} icon="rocket" title={app.meta?.title || app.meta?.name || app.slug} subtitle={t("space.workSubtitle", { target: app.targetType, version: app.latestVersion })} trailing={<StatusPill label={app.status === "published" ? t("space.published") : t("space.disabled")} tone={app.status === "published" ? "success" : "neutral"} />} onPress={() => router.push({ pathname: "/work/[appId]", params: { appId: app.id } })} />) : <ResourceEmpty text={loadingResources ? t("space.empty.worksLoading") : resourceFailures.apps ? t("space.empty.loadFailed") : t("space.empty.works")} />}</View>

    <SectionHeader title={t("space.section.saves")} />
    <View>{resources.checkpoints.length > 0 ? resources.checkpoints.map((checkpoint) => <ResourceRow key={checkpoint.id} icon="bookmark" title={checkpoint.description || t("space.save", { hash: checkpoint.commitHash.slice(0, 8) })} subtitle={`${formatRelativeTime(checkpoint.createdAt)} · ${checkpoint.commitHash.slice(0, 8)}`} />) : <ResourceEmpty text={loadingResources ? t("space.empty.savesLoading") : resourceFailures.checkpoints ? t("space.empty.loadFailed") : t("space.empty.saves")} />}</View>

    <SectionHeader title={t("space.section.tasks")} />
    <View style={{ paddingBottom: 24 }}>{resources.tasks.length > 0 ? resources.tasks.map((task) => <ResourceRow key={task.id} icon={task.status === "running" ? "sync" : task.status === "failed" ? "alert" : "check-circle"} title={task.taskType.replaceAll("_", " ")} subtitle={task.errorMessage || t("space.taskAttempt", { time: formatRelativeTime(task.updatedAt), count: task.attemptCount })} trailing={<StatusPill label={task.status} tone={task.status === "failed" ? "danger" : task.status === "running" || task.status === "pending" ? "warning" : "success"} />} onPress={task.sessionId ? () => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: task.sessionId! } }) : undefined} />) : <ResourceEmpty text={loadingResources ? t("space.empty.tasksLoading") : resourceFailures.tasks ? t("space.empty.loadFailed") : t("space.empty.tasks")} />}</View>
    </ScrollView>
    <AdaptiveSheet
      visible={spaceActionsOpen}
      title={name}
      subtitle={t("space.actions")}
      onClose={() => setSpaceActionsOpen(false)}
      scrollable={false}
      testID="space-actions-sheet"
    >
      <Text style={[typography.body, { color: theme.colors.textSecondary }]}>
        {space.description || t("space.descriptionFallback")}
      </Text>
      <SheetAction
        icon="messages"
        title={t("space.newChat")}
        detail={t("space.newChatDetail")}
        onPress={() => {
          setSpaceActionsOpen(false);
          router.push({ pathname: "/chat/[sessionId]", params: { sessionId: "new", spaceId: space.id } });
        }}
      />
      <SheetAction
        icon={space.isPinned ? "pin-off" : "pin"}
        title={space.isPinned ? t("space.unpin") : t("space.pin")}
        detail={space.isPinned ? t("space.actions.unpinDetail") : t("space.actions.pinDetail")}
        disabled={pinning}
        onPress={() => {
          void togglePin();
          setSpaceActionsOpen(false);
        }}
      />
      <SheetAction
        icon="folder-open"
        title={t("space.openFiles")}
        detail={t("space.openFilesDetail")}
        onPress={() => {
          setSpaceActionsOpen(false);
          router.push({ pathname: "/space/[spaceId]/files", params: { spaceId: space.id } });
        }}
      />
    </AdaptiveSheet>
      </View>
    </SpacePanels>
  </Screen>;
}

function SpaceMetric({ icon, label, value }: { icon: React.ComponentProps<typeof AppIcon>["name"]; label: string; value: string }) {
  const theme = useAppTheme();
  return <View style={{ flex: 1, minHeight: 75, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 13, backgroundColor: theme.colors.surface, padding: 10 }}><AppIcon name={icon} size={16} color={theme.colors.accent} /><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, marginTop: 8 }]}>{value}</Text><Text style={[typography.micro, { color: theme.colors.textMuted, marginTop: 2 }]}>{label}</Text></View>;
}

function ResourceRow({ icon, title, subtitle, trailing, onPress }: { icon: React.ComponentProps<typeof AppIcon>["name"]; title: string; subtitle: string; trailing?: React.ReactNode; onPress?: () => void }) {
  const theme = useAppTheme();
  const content = <View style={{ minHeight: 62, flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 16 }}><View style={{ width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface }}><AppIcon name={icon} size={17} color={theme.colors.textMuted} /></View><View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, textTransform: "capitalize" }]}>{title}</Text><Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>{subtitle}</Text></View>{trailing}{onPress ? <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} /> : null}</View>;
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}>{content}</Pressable> : content;
}

function ResourceEmpty({ text }: { text: string }) {
  const theme = useAppTheme();
  return <Text style={[typography.body, { color: theme.colors.textMuted, paddingHorizontal: 16, paddingVertical: 12 }]}>{text}</Text>;
}

function preferRecentSession(current: UserSessionListItem, incoming: UserSessionListItem) {
  const currentTime = Date.parse(current.lastMessageAt ?? current.updatedAt);
  const incomingTime = Date.parse(incoming.lastMessageAt ?? incoming.updatedAt);
  return Number.isFinite(currentTime) && currentTime > incomingTime ? current : incoming;
}
