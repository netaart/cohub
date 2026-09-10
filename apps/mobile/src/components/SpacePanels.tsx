/* eslint-disable react-hooks/immutability -- Reanimated shared values are intentionally mutated by gesture worklets. */
/* eslint-disable react-hooks/set-state-in-effect -- controlled panel state synchronizes the native animation surface. */
import type { CohubClient, SpaceFsEntry, UserSessionListItem } from "@neta-art/cohub";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, BackHandler, FlatList, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import Reanimated, { Extrapolation, interpolate, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionSearchRow } from "@/src/components/SearchResultRow";
import { SessionRow } from "@/src/components/SessionRow";
import { SessionLabelSheet } from "@/src/components/SessionLabelSheet";
import { SpaceFileRow } from "@/src/components/SpaceFileRow";
import { useAppTheme, typography } from "@/src/theme";
import { useTranslation } from "@/src/i18n";
import { normalizeSearchQuery, useRemoteSearch, type RemoteSessionSearchHit, type SessionNavigationTarget } from "@/src/data/session-search";
import { useApp } from "@/src/data/context";
import {
  fetchLabelSessionIds,
  fetchSessionLabels,
  formatLabelRef,
  sessionSourceGroup,
  toUserSessionLabels,
  type SessionLabel,
  type SessionSourceGroup,
} from "@/src/data/session-labels";
import { panelForScrollOffset, type PanelName } from "@/src/data/space-panel-pager";
import { AppIcon, Avatar, IconButton, PrimaryButton, SearchField } from "@/src/ui";
import { normalizeSpacePath, parentSpacePath, sortByRecent, spacePathName } from "@/src/utils";

export type SpacePanel = "chat" | "files";

type SpacePanelsProps = {
  spaceId: string;
  spaceName: string;
  sessions: UserSessionListItem[];
  client: CohubClient | null;
  activePanel: SpacePanel | null;
  onActivePanelChange: (panel: SpacePanel | null) => void;
  onOpenSession: (sessionId: string, target?: SessionNavigationTarget) => void;
  onNewChat: () => void;
  onOpenFile: (path: string) => void;
  onOpenFilesPage: () => void;
  children: ReactNode;
};

const PANEL_WIDTH_RATIO = 0.86;
const MAX_PANEL_WIDTH = 360;
/** Time without scroll events before the pager commits to its nearest page. */
const PANEL_SCROLL_IDLE_MS = 140;
/** A programmatic close has no drag-end event; give the native scroll animation time to land. */
const PANEL_CLOSE_SETTLE_MS = 380;

/**
 * Push-style pager. The Chats/Files gesture is a native horizontal scroll, which is also the
 * only arbitration Android gives us: the ScrollView intercepts a horizontal drag and the text
 * underneath receives ACTION_CANCEL (so a long press never turns into a selection mid-swipe),
 * while a text selection keeps precedence because the native text view sets
 * FLAG_DISALLOW_INTERCEPT, which disables that interception.
 */
export function SpacePanels({ spaceId, spaceName, sessions, client, activePanel, onActivePanelChange, onOpenSession, onNewChat, onOpenFile, onOpenFilesPage, children }: SpacePanelsProps) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(MAX_PANEL_WIDTH, Math.max(280, width * PANEL_WIDTH_RATIO));
  const centerOffset = panelWidth;
  const filesOffset = panelWidth + width;
  const snapOffsets = useMemo(() => [0, centerOffset, filesOffset], [centerOffset, filesOffset]);
  const pagerRef = useRef<ScrollView>(null);
  const scrollOffset = useSharedValue(centerOffset);
  const scrim = useSharedValue(activePanel ? 1 : 0);
  const shownPanel = useSharedValue<PanelName | 0>(activePanel ?? 0);
  const [pagerScrollEnabled, setPagerScrollEnabled] = useState(true);
  const [visiblePanel, setVisiblePanel] = useState<PanelName | null>(activePanel);
  const [interactive, setInteractive] = useState(Boolean(activePanel));
  const visiblePanelRef = useRef<PanelName | null>(activePanel);
  const activePanelRef = useRef<PanelName | null>(activePanel);
  const initialScrollDone = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearIdleTimer = useCallback(() => {
    if (idleTimer.current === null) return;
    clearTimeout(idleTimer.current);
    idleTimer.current = null;
  }, []);
  useEffect(() => clearIdleTimer, [clearIdleTimer]);

  const showPanel = useCallback((panel: PanelName) => {
    if (visiblePanelRef.current === panel) return;
    visiblePanelRef.current = panel;
    setVisiblePanel(panel);
  }, []);

  const commitOpen = useCallback((panel: PanelName) => {
    activePanelRef.current = panel;
    visiblePanelRef.current = panel;
    setVisiblePanel(panel);
    setInteractive(true);
    onActivePanelChange(panel);
  }, [onActivePanelChange]);

  const commitClosed = useCallback(() => {
    activePanelRef.current = null;
    visiblePanelRef.current = null;
    setVisiblePanel(null);
    setInteractive(false);
    onActivePanelChange(null);
  }, [onActivePanelChange]);

  const settle = useCallback(() => {
    clearIdleTimer();
    const panel = panelForScrollOffset(scrollOffset.get(), centerOffset, filesOffset);
    if (panel) commitOpen(panel);
    else commitClosed();
  }, [centerOffset, clearIdleTimer, commitClosed, commitOpen, filesOffset, scrollOffset]);

  const scheduleSettle = useCallback(() => {
    clearIdleTimer();
    idleTimer.current = setTimeout(settle, PANEL_SCROLL_IDLE_MS);
  }, [clearIdleTimer, settle]);

  const closePanel = useCallback(() => {
    activePanelRef.current = null;
    onActivePanelChange(null);
    clearIdleTimer();
    pagerRef.current?.scrollTo({ x: centerOffset, animated: true });
    idleTimer.current = setTimeout(settle, PANEL_CLOSE_SETTLE_MS);
  }, [centerOffset, clearIdleTimer, onActivePanelChange, settle]);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      const offset = event.contentOffset.x;
      scrollOffset.value = offset;
      const distance = Math.abs(offset - centerOffset);
      scrim.value = interpolate(distance, [0, panelWidth], [0, 1], Extrapolation.CLAMP);
      if (distance <= 8) return;
      const panel: PanelName = offset < centerOffset ? "chat" : "files";
      if (shownPanel.value === panel) return;
      shownPanel.value = panel;
      scheduleOnRN(showPanel, panel);
    },
  }, [centerOffset, panelWidth, scrim, scrollOffset, showPanel, shownPanel]);

  useEffect(() => {
    if (!isFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!activePanelRef.current && !visiblePanelRef.current) return false;
      closePanel();
      return true;
    });
    return () => subscription.remove();
  }, [closePanel, isFocused]);

  // Keep the settled page aligned when the panel or window width changes.
  useEffect(() => {
    const panel = activePanelRef.current ?? visiblePanelRef.current;
    const x = panel === "chat" ? 0 : panel === "files" ? filesOffset : centerOffset;
    scrollOffset.value = x;
    pagerRef.current?.scrollTo({ x, animated: false });
  }, [centerOffset, filesOffset, scrollOffset]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrim.value * 0.52 }));

  const handleChipsTouchChange = useCallback((touching: boolean) => {
    // The filter chips are a nested horizontal ScrollView; it only wins its drag while the
    // pager is not scrolling, so touch-start there disables the pager for this gesture.
    setPagerScrollEnabled(!touching);
  }, []);

  const pageStyle = (panel: PanelName) => [
    styles.panelPage,
    panel === "chat" ? styles.panelPageLeft : styles.panelPageRight,
    {
      width: panelWidth,
      paddingBottom: insets.bottom,
      backgroundColor: theme.colors.background,
      borderColor: theme.colors.border,
    },
  ];

  return (
    <View style={styles.nativeRoot} collapsable={false}>
      <Reanimated.ScrollView
        ref={pagerRef}
        horizontal
        style={styles.pager}
        showsHorizontalScrollIndicator={false}
        bounces={false}
        overScrollMode="never"
        scrollEventThrottle={16}
        scrollEnabled={pagerScrollEnabled}
        snapToOffsets={snapOffsets}
        decelerationRate="fast"
        disableIntervalMomentum
        contentOffset={{ x: centerOffset, y: 0 }}
        onScroll={scrollHandler}
        onScrollBeginDrag={clearIdleTimer}
        onScrollEndDrag={scheduleSettle}
        onMomentumScrollBegin={clearIdleTimer}
        onMomentumScrollEnd={settle}
        onContentSizeChange={() => {
          if (initialScrollDone.current) return;
          initialScrollDone.current = true;
          scrollOffset.value = centerOffset;
          pagerRef.current?.scrollTo({ x: centerOffset, animated: false });
        }}
      >
        {/* Pages fill the pager's own height. Seeding it from the window height overshot by the
            status bar, top inset, and Android navigation bar whenever the pager's onLayout did
            not correct it, which pushed the composer below the visible area. */}
        <View style={styles.pages}>
          <View
            style={pageStyle("chat")}
            accessibilityViewIsModal={interactive && visiblePanel === "chat"}
            accessibilityElementsHidden={!(interactive && visiblePanel === "chat")}
            importantForAccessibility={interactive && visiblePanel === "chat" ? "yes" : "no-hide-descendants"}
          >
            {visiblePanel === "chat"
              ? interactive
                ? <ChatPanel spaceId={spaceId} spaceName={spaceName} sessions={sessions} client={client} onChipsTouchChange={handleChipsTouchChange} onClose={closePanel} onNewChat={() => { closePanel(); onNewChat(); }} onOpenSession={(sessionId, target) => { closePanel(); onOpenSession(sessionId, target); }} />
                : <PanelGesturePreview panel="chat" />
              : null}
          </View>
          <View style={[styles.contentPage, { width }]} accessibilityElementsHidden={visiblePanel !== null} importantForAccessibility={visiblePanel ? "no-hide-descendants" : "auto"}>
            {children}
            <Reanimated.View style={[styles.backdrop, scrimStyle]} pointerEvents={interactive ? "auto" : "none"}>
              <Pressable accessibilityRole="button" accessibilityLabel={t("space.panel.close")} style={styles.fill} onPress={closePanel} />
            </Reanimated.View>
          </View>
          <View
            style={pageStyle("files")}
            accessibilityViewIsModal={interactive && visiblePanel === "files"}
            accessibilityElementsHidden={!(interactive && visiblePanel === "files")}
            importantForAccessibility={interactive && visiblePanel === "files" ? "yes" : "no-hide-descendants"}
          >
            {visiblePanel === "files"
              ? interactive
                ? <FilesPanel enabled spaceId={spaceId} spaceName={spaceName} client={client} onClose={closePanel} onOpenFile={(path) => { closePanel(); onOpenFile(path); }} onOpenFilesPage={() => { closePanel(); onOpenFilesPage(); }} />
                : <PanelGesturePreview panel="files" />
              : null}
          </View>
        </View>
      </Reanimated.ScrollView>
    </View>
  );
}

function PanelGesturePreview({ panel }: { panel: SpacePanel }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  return <View style={styles.panelContent} accessibilityElementsHidden><View style={[styles.header, { borderBottomColor: theme.colors.border }]}><AppIcon name={panel === "chat" ? "messages" : "folder-open"} size={19} color={theme.colors.accent} /><Text style={[typography.heading, { color: theme.colors.text }]}>{panel === "chat" ? t("space.panel.chats") : t("space.panel.files")}</Text></View></View>;
}

function PanelHeader({ title, subtitle, onClose, action, avatar }: { title: string; subtitle?: string; onClose: () => void; action?: ReactNode; avatar?: ReactNode }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  return (
    <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
      {avatar}
      <View style={styles.headerText}>
        <Text numberOfLines={1} style={[typography.heading, { color: theme.colors.text }]}>{title}</Text>
        {subtitle ? <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>{subtitle}</Text> : null}
      </View>
      {action}
      <IconButton name="x" label={t("ui.sheet.close", { title })} size={36} onPress={onClose} />
    </View>
  );
}

function mergePanelSessions(current: UserSessionListItem[], incoming: UserSessionListItem[], spaceId: string, spaceName: string) {
  const knownSpace = current.find((session) => session.space)?.space ?? { id: spaceId, name: spaceName, slug: null, publicProfile: null };
  const byId = new Map(current.map((session) => [session.id, session]));
  for (const session of incoming) {
    const previous = byId.get(session.id);
    byId.set(session.id, { ...previous, ...session, space: session.space ?? previous?.space ?? knownSpace });
  }
  return sortByRecent([...byId.values()]);
}

function isOlderSession(left: UserSessionListItem, right: UserSessionListItem) {
  const leftTime = left.lastMessageAt ? Date.parse(left.lastMessageAt) : null;
  const rightTime = right.lastMessageAt ? Date.parse(right.lastMessageAt) : null;
  if (leftTime === null && rightTime !== null) return true;
  if (leftTime !== null && rightTime === null) return false;
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime < rightTime;
  return left.id < right.id;
}

function cursorAfterOldestSession(sessions: UserSessionListItem[]) {
  const oldest = sessions.reduce<UserSessionListItem | null>((current, session) => {
    if (!current || isOlderSession(session, current)) return session;
    return current;
  }, null);
  if (!oldest) return null;
  const date = oldest.lastMessageAt ? new Date(oldest.lastMessageAt) : null;
  if (date && !Number.isFinite(date.getTime())) return null;
  return `${date ? date.toISOString() : "null"}|${oldest.id}`;
}

type ChatPanelItem =
  | { kind: "local"; session: UserSessionListItem }
  | { kind: "remote"; hit: RemoteSessionSearchHit };

type ChatListFilter =
  | { kind: "all" }
  | { kind: "source"; source: SessionSourceGroup }
  | { kind: "label"; label: SessionLabel; ref: string };

function ChatPanel({ spaceId, spaceName, sessions, client, onChipsTouchChange, onClose, onNewChat, onOpenSession }: { spaceId: string; spaceName: string; sessions: UserSessionListItem[]; client: CohubClient | null; onChipsTouchChange: (touching: boolean) => void; onClose: () => void; onNewChat: () => void; onOpenSession: (sessionId: string, target?: SessionNavigationTarget) => void }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const { state, refreshSessionStatuses } = useApp();
  const [query, setQuery] = useState("");
  const [extraSessions, setExtraSessions] = useState<UserSessionListItem[]>([]);
  const [scopeCursor, setScopeCursor] = useState<string | null>(null);
  const [scopeHasMore, setScopeHasMore] = useState(false);
  const [scopeInitialized, setScopeInitialized] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [listFilter, setListFilter] = useState<ChatListFilter>({ kind: "all" });
  const [labels, setLabels] = useState<SessionLabel[]>([]);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [labelsReloadToken, setLabelsReloadToken] = useState(0);
  const [labelSessionIds, setLabelSessionIds] = useState<Set<string>>(new Set());
  const [labelSessionsLoading, setLabelSessionsLoading] = useState(false);
  const [labelSessionsError, setLabelSessionsError] = useState<string | null>(null);
  const [labelSheetSession, setLabelSheetSession] = useState<UserSessionListItem | null>(null);
  const remoteSearch = useRemoteSearch(client, query, { enabled: Boolean(spaceId), spaceId, types: ["session", "turn"] });
  const displaySessions = useMemo(() => mergePanelSessions(extraSessions, sessions, spaceId, spaceName), [extraSessions, sessions, spaceId, spaceName]);
  const remoteQueryMatches = remoteSearch.query === normalizeSearchQuery(query);

  useEffect(() => {
    setLabels([]);
    setLabelsError(null);
    setListFilter({ kind: "all" });
    setLabelSheetSession(null);
  }, [client, spaceId]);

  useEffect(() => {
    if (!client || !spaceId) return;
    let active = true;
    setLabelsError(null);
    void fetchSessionLabels(client, spaceId)
      .then((tree) => {
        if (!active) return;
        setLabels(toUserSessionLabels(tree));
      })
      .catch((error) => {
        if (active) setLabelsError(error instanceof Error ? error.message : t("labels.error"));
      });
    return () => {
      active = false;
    };
  }, [client, spaceId, labelsReloadToken, t]);

  useEffect(() => {
    if (!client || !spaceId || listFilter.kind !== "label") {
      setLabelSessionIds(new Set());
      setLabelSessionsError(null);
      return;
    }
    let active = true;
    setLabelSessionsLoading(true);
    setLabelSessionsError(null);
    void fetchLabelSessionIds(client, spaceId, listFilter.ref)
      .then((ids) => {
        if (active) setLabelSessionIds(new Set(ids));
      })
      .catch((error) => {
        if (active) setLabelSessionsError(error instanceof Error ? error.message : t("labels.loadedLabeledChatsError"));
      })
      .finally(() => {
        if (active) setLabelSessionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, listFilter, spaceId, t]);

  const openLabelSheet = useCallback((session: UserSessionListItem) => {
    setLabelSheetSession(session);
  }, []);
  const closeLabelSheet = useCallback(() => setLabelSheetSession(null), []);

  const trimmedQuery = normalizeSearchQuery(query);
  const needle = trimmedQuery.toLowerCase();
  const matchesListFilter = (session: UserSessionListItem) => {
    if (listFilter.kind === "all") return true;
    if (listFilter.kind === "source") return sessionSourceGroup(session) === listFilter.source;
    return labelSessionIds.has(session.id);
  };
  const filteredSessions = displaySessions.filter((session) =>
    (!needle || [session.title, session.latestMessageText, session.space?.name].some((value) => value ? normalizeSearchQuery(value).toLowerCase().includes(needle) : false)) &&
    matchesListFilter(session),
  );
  const sessionsById = useMemo(() => new Map(displaySessions.map((session) => [session.id, session])), [displaySessions]);
  const listItems = useMemo<ChatPanelItem[]>(() => {
    if (!trimmedQuery) return filteredSessions.map((session) => ({ kind: "local", session }));
    const remoteSessions = remoteQueryMatches
      ? remoteSearch.sessions.filter((hit) => {
        const session = sessionsById.get(hit.sessionId);
        if (listFilter.kind === "all") return true;
        if (listFilter.kind === "source") return session ? sessionSourceGroup(session) === listFilter.source : false;
        return labelSessionIds.has(hit.sessionId);
      })
      : [];
    const remoteIds = new Set(remoteSessions.map((hit) => hit.sessionId));
    return [
      ...remoteSessions.map((hit) => ({ kind: "remote" as const, hit })),
      ...filteredSessions.filter((session) => !remoteIds.has(session.id)).map((session) => ({ kind: "local" as const, session })),
    ];
  }, [filteredSessions, labelSessionIds, listFilter, remoteQueryMatches, remoteSearch.sessions, sessionsById, trimmedQuery]);
  const loadMore = async () => {
    if (!client || loadingMore || (scopeInitialized && !scopeHasMore)) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const cursor = scopeCursor ?? cursorAfterOldestSession(sessions);
      const response = await client.space(spaceId).sessions.list({ limit: 60, ...(cursor ? { cursor } : {}) });
      setExtraSessions((current) => mergePanelSessions(current, response.sessions, spaceId, spaceName));
      void refreshSessionStatuses(response.sessions);
      setScopeCursor(response.pageInfo?.nextCursor ?? null);
      setScopeHasMore(Boolean(response.pageInfo?.hasMore));
      setScopeInitialized(true);
    } catch (error) {
      setLoadMoreError(error instanceof Error ? error.message : t("space.panel.loadMoreError"));
    } finally {
      setLoadingMore(false);
    }
  };
  const showLoadMore = Boolean(client && !trimmedQuery && (!scopeInitialized || scopeHasMore));
  const emptyLoading = (remoteQueryMatches && remoteSearch.loading) || labelSessionsLoading;
  const emptyLabel = listFilter.kind === "label"
    ? t("space.panel.empty.labeled", { name: listFilter.label.name })
    : listFilter.kind === "source"
      ? listFilter.source === "web" ? t("space.panel.empty.web") : t("space.panel.empty.other")
    : trimmedQuery
      ? t("space.panel.empty.matching")
      : t("space.panel.empty.none");
  const filterChips: { key: string; label: string; icon?: React.ComponentProps<typeof AppIcon>["name"]; filter: ChatListFilter }[] = [
    { key: "all", label: t("space.panel.filter.all"), filter: { kind: "all" } },
    { key: "web", label: t("space.panel.filter.webApp"), icon: "globe", filter: { kind: "source", source: "web" } },
    { key: "other", label: t("space.panel.filter.other"), icon: "globe", filter: { kind: "source", source: "other" } },
    ...labels.map((label) => ({ key: `label:${label.id}`, label: label.name, filter: { kind: "label" as const, label, ref: formatLabelRef(label) } })),
  ];
  const chipRow = <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
    {filterChips.map((chip) => (
      <PanelFilterChip
        key={chip.key}
        label={chip.label}
        icon={chip.icon}
        selected={chip.filter.kind === "all" ? listFilter.kind === "all" : chip.filter.kind === "source" ? listFilter.kind === "source" && listFilter.source === chip.filter.source : listFilter.kind === "label" && listFilter.label.id === chip.filter.label.id}
        onPress={() => setListFilter(chip.filter)}
      />
    ))}
    {labelsError ? <Pressable accessibilityRole="button" accessibilityLabel={t("space.panel.retryLabelsA11y")} onPress={() => setLabelsReloadToken((value) => value + 1)}><Text style={[typography.caption, { color: theme.colors.accent }]}>{t("space.panel.retryLabels")}</Text></Pressable> : null}
  </ScrollView>;
  return (
    <View style={styles.panelContent}>
      <PanelHeader title={spaceName} subtitle={t("space.panel.chats")} onClose={onClose} avatar={<Avatar name={spaceName} uri={displaySessions.find((session) => session.space?.publicProfile?.avatarUrl)?.space?.publicProfile?.avatarUrl} size={38} />} />
      <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, gap: 9 }}>
        <PrimaryButton label={t("space.newChat")} icon="plus" onPress={onNewChat} style={{ minHeight: 44 }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }}><SearchField value={query} onChangeText={setQuery} placeholder={t("space.panel.searchChats")} /></View>
          {remoteQueryMatches && remoteSearch.loading ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
        </View>
        <View onTouchStart={() => onChipsTouchChange(true)} onTouchEnd={() => onChipsTouchChange(false)} onTouchCancel={() => onChipsTouchChange(false)}>{chipRow}</View>
        {remoteQueryMatches && remoteSearch.error && trimmedQuery.length >= 2 ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text selectable style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{remoteSearch.error}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("chats.search.retry")} onPress={remoteSearch.retry}><Text style={[typography.micro, { color: theme.colors.accent }]}>{t("common.retry")}</Text></Pressable></View> : null}
        {state.sessionStatusError ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{state.sessionStatusError}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("space.panel.retryStatuses")} onPress={() => void refreshSessionStatuses(displaySessions)}><Text style={[typography.micro, { color: theme.colors.accent }]}>{t("common.retry")}</Text></Pressable></View> : null}
        {labelSessionsError ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text selectable style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{labelSessionsError}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("space.panel.retryLabeledChats")} onPress={() => setLabelsReloadToken((value) => value + 1)}><Text style={[typography.micro, { color: theme.colors.accent }]}>{t("common.retry")}</Text></Pressable></View> : null}
      </View>
      <FlatList
        data={listItems}
        keyExtractor={(item) => item.kind === "remote" ? `remote:${item.hit.sessionId}` : `local:${item.session.id}`}
        renderItem={({ item }) => item.kind === "remote"
          ? <SessionSearchRow hit={item.hit} showSpace={false} onPress={(target) => onOpenSession(item.hit.sessionId, target)} />
          : <SessionRow session={item.session} showSpace={false} onPress={() => onOpenSession(item.session.id)} onLongPress={client ? () => openLabelSheet(item.session) : undefined} />}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 24, flexGrow: listItems.length === 0 ? 1 : undefined }}
        ListFooterComponent={showLoadMore ? <View>{loadMoreError ? <Text selectable style={[typography.micro, { color: theme.colors.danger, marginHorizontal: 14, marginTop: 8 }]}>{loadMoreError}</Text> : null}<Pressable accessibilityRole="button" accessibilityLabel={loadMoreError ? t("space.panel.retryLoadMore") : t("space.panel.loadMore")} disabled={loadingMore} onPress={() => void loadMore()} style={({ pressed }) => ({ minHeight: 40, marginHorizontal: 14, marginTop: 8, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" })}>{loadingMore ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <Text style={[typography.caption, { color: theme.colors.accent }]}>{loadMoreError ? t("space.panel.retryLoadMore") : t("space.panel.loadMore")}</Text>}</Pressable></View> : null}
        ListEmptyComponent={<View style={styles.emptyPanel}>{emptyLoading ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <AppIcon name={listFilter.kind === "label" ? "tag" : trimmedQuery ? "search" : "messages"} size={26} color={theme.colors.textMuted} />}<Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 10, textAlign: "center" }]}>{emptyLabel}</Text></View>}
      />
      {labelSheetSession && client ? <SessionLabelSheet client={client} spaceId={spaceId} session={labelSheetSession} labels={labels} labelsError={labelsError} onLabelsReload={() => setLabelsReloadToken((value) => value + 1)} onClose={closeLabelSheet} onChanged={() => { setLabelSessionIds(new Set()); setLabelsReloadToken((value) => value + 1); }} /> : null}
    </View>
  );
}

function PanelFilterChip({ label, icon, selected, onPress }: { label: string; icon?: React.ComponentProps<typeof AppIcon>["name"]; selected: boolean; onPress: () => void }) {
  const theme = useAppTheme();
  return <Pressable accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} style={({ pressed }) => ({ minHeight: 32, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: selected ? theme.colors.accentBorder : theme.colors.border, backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface, flexDirection: "row", alignItems: "center", gap: 5 })}>{icon ? <AppIcon name={icon} size={13} color={selected ? theme.colors.accent : theme.colors.textMuted} /> : null}<Text style={[typography.caption, { color: selected ? theme.colors.accent : theme.colors.textMuted }]}>{label}</Text></Pressable>;
}

function FilesPanel({ enabled = true, spaceId, spaceName, client, onClose, onOpenFile, onOpenFilesPage }: { enabled?: boolean; spaceId: string; spaceName: string; client: CohubClient | null; onClose: () => void; onOpenFile: (path: string) => void; onOpenFilesPage: () => void }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<SpaceFsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!enabled) return;
    const currentRequest = ++requestIdRef.current;
    if (!client) {
      setEntries([]);
      setError(t("files.panelConnect"));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await client.space(spaceId).files.list(path || undefined);
      if (currentRequest === requestIdRef.current) setEntries(result.entries);
    } catch (caught) {
      if (currentRequest === requestIdRef.current) setError(caught instanceof Error ? caught.message : t("files.loadError"));
    } finally {
      if (currentRequest === requestIdRef.current) setLoading(false);
    }
  }, [client, enabled, path, spaceId, t]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void load();
    });
    return () => {
      active = false;
      requestIdRef.current += 1;
    };
  }, [enabled, load]);

  const openEntry = (entry: SpaceFsEntry) => {
    if (entry.type === "dir") {
      setPath(normalizeSpacePath(entry.path));
      return;
    }
    onOpenFile(entry.path);
  };

  return (
    <View style={styles.panelContent}>
      <PanelHeader title={path ? spacePathName(path) : t("files.title")} subtitle={path ? `${spaceName} / ${path}` : spaceName} onClose={onClose} action={<IconButton name="external-link" label={t("space.panel.openFullFiles")} size={36} onPress={onOpenFilesPage} />} />
      {path ? <Pressable accessibilityRole="button" accessibilityLabel={t("space.panel.backToParent")} onPress={() => setPath(parentSpacePath(path))} style={({ pressed }) => [styles.parentBar, { borderBottomColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" }]}><AppIcon name="arrow-left" size={16} color={theme.colors.textMuted} /><Text style={[typography.caption, { color: theme.colors.textSecondary }]}>{parentSpacePath(path) ? t("files.backTo", { name: spacePathName(parentSpacePath(path)) }) : t("files.backToFiles")}</Text></Pressable> : null}
      {loading ? (
        <View style={styles.emptyPanel}><ActivityIndicator size="small" color={theme.colors.accent} /><Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 10 }]}>{t("files.loading")}</Text></View>
      ) : error ? (
        <View style={styles.emptyPanel}><AppIcon name="cloud-off" size={25} color={theme.colors.danger} /><Text style={[typography.body, { color: theme.colors.danger, textAlign: "center", marginTop: 10 }]}>{error}</Text><PrimaryButton label={t("common.retry")} icon="refresh" onPress={() => void load()} style={{ marginTop: 15, minHeight: 42 }} /></View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.path}
          contentContainerStyle={{ paddingVertical: 8, paddingBottom: 24, flexGrow: entries.length === 0 ? 1 : undefined }}
          renderItem={({ item }) => <SpaceFileRow entry={item} compact onPress={() => openEntry(item)} />}
          ListEmptyComponent={<View style={styles.emptyPanel}><AppIcon name="folder-open" size={26} color={theme.colors.textMuted} /><Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 10, textAlign: "center" }]}>{path ? t("files.emptyFolder") : t("files.emptyWorkspace")}</Text></View>}
        />
      )}
    </View>
  );
}

const styles = {
  nativeRoot: { flex: 1, minHeight: 0, overflow: "hidden" as const },
  pager: { flex: 1 },
  pages: { flexDirection: "row" as const, height: "100%" as const },
  contentPage: { height: "100%" as const },
  panelPage: { height: "100%" as const, borderLeftWidth: 1, borderRightWidth: 1, shadowColor: "#000000", shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.25, shadowRadius: 18, elevation: 12 },
  panelPageLeft: { borderLeftWidth: 0 },
  panelPageRight: { borderRightWidth: 0 },
  fill: { flex: 1 } as const,
  backdrop: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "#000000" },
  panelContent: { flex: 1, minHeight: 0 },
  header: { minHeight: 62, paddingHorizontal: 10, paddingVertical: 7, flexDirection: "row" as const, alignItems: "center" as const, gap: 5, borderBottomWidth: 1 },
  headerText: { flex: 1, minWidth: 0, paddingHorizontal: 3 },
  emptyPanel: { flex: 1, minHeight: 180, alignItems: "center" as const, justifyContent: "center" as const, padding: 24 },
  parentBar: { minHeight: 40, paddingHorizontal: 14, flexDirection: "row" as const, alignItems: "center" as const, gap: 8, borderBottomWidth: 1 },
} satisfies Record<string, object>;
