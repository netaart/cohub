import { useFocusEffect, useIsFocused, useRouter, useScrollToTop } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LegendList, type LegendListRef, type ViewToken } from "@legendapp/list/react-native";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { AccountAvatar } from "@/src/components/AccountAvatar";
import { AnchoredActionMenu } from "@/src/components/AnchoredActionMenu";
import { useFloatingTabBarInset } from "@/src/components/FloatingTabBar";
import { SessionSearchRow, SpaceSearchRow } from "@/src/components/SearchResultRow";
import { SessionRow } from "@/src/components/SessionRow";
import { useToast } from "@/src/components/Toast";
import { normalizeSearchQuery, useRemoteSearch, type RemoteSessionSearchHit, type RemoteSpaceSearchHit, type SessionNavigationTarget } from "@/src/data/session-search";
import { useSpaceSessionCounts } from "@/src/data/space-session-counts";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { useTranslation } from "@/src/i18n";
import { AppIcon, ConnectionBanner, DataError, EmptyState, ExpandableSearchBar, IconButton, LoadingRows, Screen } from "@/src/ui";
import { sessionListStatus, hasMoreRecentSessions, isSessionInFilterWindow, sessionFilterCutoff } from "@/src/data/session-status";
import { loadSessionFilterMinutes, loadSessionSourcePreference, saveSessionSourcePreference, useSessionFilterPreference, useSessionSourcePreference } from "@/src/data/session-filter-preference";
import type { SessionSourceFilter } from "@/src/data/session-source";
import { useSourceSessions } from "@/src/data/use-source-sessions";
import { useSyncScope } from "@/src/data/use-sync-scope";
import { useSpaceRealtime } from "@/src/data/use-space-realtime";
import { emptyRunningSessions } from "@/src/data/running-sessions";
import { SpaceRow } from "@/src/components/SpaceRow";
import { EdgeHeader, useEdgeChrome } from "@/src/ui/EdgeChrome";

type Filter = "all" | "running" | "completed";
type ChatListItem =
  | { kind: "local-session"; session: import("@neta-art/cohub").UserSessionListItem }
  | { kind: "remote-session"; hit: RemoteSessionSearchHit }
  | { kind: "local-space"; space: import("@neta-art/cohub").SpaceRecord }
  | { kind: "remote-space"; hit: RemoteSpaceSearchHit };
const CHAT_SEARCH_TYPES = ["session", "turn", "space"] as const;

export default function ChatsScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const tabBarInset = useFloatingTabBarInset();
  const { headerHeight, onHeaderLayout } = useEdgeChrome();
  const isFocused = useIsFocused();
  const { state, client, connectionState, refreshHome, refreshChats, discoverRunningSessions, refreshSessionStatuses, loadMoreSessions, prefetchSession } = useApp();
  const filterPreference = useSessionFilterPreference();
  const [cutoff, setCutoff] = useState(() => sessionFilterCutoff(filterPreference.minutes, Date.now()));
  const searchRef = useRef<TextInput>(null);
  const listRef = useRef<LegendListRef>(null);
  useScrollToTop(listRef);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const sourcePreference = useSessionSourcePreference();
  const sourceFilter = sourcePreference.filter;
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const sourceButtonRef = useRef<View>(null);
  const toast = useToast();
  const selectSource = (next: SessionSourceFilter) => {
    if (next === sourceFilter) return;
    void saveSessionSourcePreference(next).catch(() => toast({ title: t("chats.source.saveFailed") }));
  };
  const sourceSessions = useSourceSessions(client, sourceFilter);
  const sourceSessionList = sourceSessions.sessions;
  const sourceLoadMore = sourceSessions.loadMore;
  const sourceLoadingMore = sourceSessions.loadingMore;
  const runningQuery = state.runningSessions[sourceFilter] ?? emptyRunningSessions;
  const baseSessions = filter === "running" ? runningQuery.sessions : sourceFilter === "all" ? state.sessions : sourceSessionList;
  useSyncScope(`running:${sourceFilter}`, () => discoverRunningSessions(sourceFilter), 30_000, filter === "running" && !state.booting, 30_000);
  const [visibleSpaceIds, setVisibleSpaceIds] = useState<string[]>([]);
  useSpaceRealtime(visibleSpaceIds);
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken<ChatListItem>[] }) => {
    const ids = [...new Set(viewableItems.filter((token) => token.isViewable).map(({ item }) => item.kind === "local-session" ? item.session.spaceId : item.kind === "local-space" ? item.space.id : item.hit.spaceId))].slice(0, 10);
    setVisibleSpaceIds((previous) => previous.join(",") === ids.join(",") ? previous : ids);
  }, []);
  const activeChats = baseSessions.some((session) => sessionListStatus(session, state.sessionLatestTurns[session.id], state.sessionTurnStatuses) === "running");
  useSyncScope("chats", refreshChats, activeChats ? 15_000 : 30_000, sourceFilter === "all" && filter !== "running" && !state.booting);
  const dataError = (filter === "running" ? runningQuery.error : filterPreference.error ?? state.sessionsError ?? sourceSessions.error) ?? sourcePreference.error ?? state.error ?? state.realtimeError ?? state.sessionStatusError;
  const remoteSearch = useRemoteSearch(client, query, { enabled: filter === "all" && sourceFilter === "all", types: CHAT_SEARCH_TYPES });
  const trimmedQuery = normalizeSearchQuery(query);
  const sessionsRef = useRef(baseSessions);
  useEffect(() => { sessionsRef.current = baseSessions; }, [baseSessions]);
  useEffect(() => {
    if (sourceFilter === "all" || sourceSessionList.length === 0) return;
    void refreshSessionStatuses(sourceSessionList, { silent: true });
  }, [refreshSessionStatuses, sourceFilter, sourceSessionList]);
  useFocusEffect(useCallback(() => {
    if (filter !== "completed" || !filterPreference.loaded) return;
    const updateCutoff = () => setCutoff(sessionFilterCutoff(filterPreference.minutes, Date.now()));
    updateCutoff();
    void refreshSessionStatuses(sessionsRef.current);
    const timer = setInterval(updateCutoff, 30_000);
    return () => clearInterval(timer);
  }, [filter, filterPreference.loaded, filterPreference.minutes, refreshSessionStatuses]));

  const localSessions = useMemo(() => {
    const needle = trimmedQuery.toLowerCase();
    return baseSessions.filter((session) => {
      const matchesFilter = filter === "all" || ((filter === "running" || isSessionInFilterWindow(session, cutoff)) && sessionListStatus(session, state.sessionLatestTurns[session.id], state.sessionTurnStatuses) === filter);
      if (!matchesFilter) return false;
      if (!needle) return true;
      return [session.title, session.latestMessageText, session.space?.name].some((value) => value ? normalizeSearchQuery(value).toLowerCase().includes(needle) : false);
    });
  }, [baseSessions, cutoff, filter, state.sessionLatestTurns, state.sessionTurnStatuses, trimmedQuery]);
  const localSpaces = useMemo(() => {
    if (filter !== "all" || sourceFilter !== "all" || !trimmedQuery) return [];
    const needle = trimmedQuery.toLowerCase();
    return state.spaces.filter((space) => [space.name, space.title, space.description].some((value) => value ? normalizeSearchQuery(value).toLowerCase().includes(needle) : false));
  }, [filter, sourceFilter, state.spaces, trimmedQuery]);
  const countSpaceIds = useMemo(() => localSpaces.filter((space) => !space.description?.trim()).map((space) => space.id), [localSpaces]);
  // Search results reuse already-probed counts; they do not fan out probes of their own.
  const spaceSessionCounts = useSpaceSessionCounts(client, countSpaceIds, { probe: false });
  const listItems = useMemo<ChatListItem[]>(() => {
    if (!trimmedQuery || filter !== "all" || sourceFilter !== "all") return localSessions.map((session) => ({ kind: "local-session", session }));
    const remoteQueryMatches = remoteSearch.query === trimmedQuery;
    const remoteSessions = remoteQueryMatches ? remoteSearch.sessions : [];
    const remoteSpaces = remoteQueryMatches ? remoteSearch.spaces : [];
    const remoteSessionIds = new Set(remoteSessions.map((hit) => hit.sessionId));
    const remoteSpaceIds = new Set(remoteSpaces.map((hit) => hit.spaceId));
    return [
      ...remoteSessions.map((hit) => ({ kind: "remote-session" as const, hit })),
      ...localSessions.filter((session) => !remoteSessionIds.has(session.id)).map((session) => ({ kind: "local-session" as const, session })),
      ...remoteSpaces.map((hit) => ({ kind: "remote-space" as const, hit })),
      ...localSpaces.filter((space) => !remoteSpaceIds.has(space.id)).map((space) => ({ kind: "local-space" as const, space })),
    ];
  }, [filter, localSessions, localSpaces, remoteSearch.query, remoteSearch.sessions, remoteSearch.spaces, sourceFilter, trimmedQuery]);

  // LegendList memoizes each row on [item, extraData]; cached space counts load after the
  // first render but never change `listItems`, so they must flow through extraData.
  const rowExtraData = useMemo(
    () => ({ spaceSessionCounts, t, theme, prefetchSession }),
    [spaceSessionCounts, t, theme, prefetchSession],
  );

  const filteringPages = isFocused && client !== null && sourceFilter === "all" && filter === "completed" && filterPreference.loaded && !state.refreshing && !dataError && hasMoreRecentSessions({ hasMore: state.sessionsHasMore, cursor: state.sessionsCursor, boundary: state.sessionsPageBoundary, cutoff });
  const sourceBoundary = sourceSessionList.at(-1) ?? null;
  const sourceFilteringPages = isFocused && client !== null && sourceFilter !== "all" && filter === "completed" && filterPreference.loaded && !dataError && hasMoreRecentSessions({ hasMore: sourceSessions.hasMore, cursor: sourceSessions.hasMore ? "more" : null, boundary: sourceBoundary ? { lastMessageAt: sourceBoundary.lastMessageAt } : null, cutoff });
  const statusesLoading = state.sessionStatusRequests > 0;
  useEffect(() => {
    if (filteringPages && !state.refreshing && !state.sessionsLoadingMore && !statusesLoading) void loadMoreSessions();
  }, [filteringPages, loadMoreSessions, state.refreshing, state.sessionsCursor, state.sessionsLoadingMore, statusesLoading]);
  useEffect(() => {
    if (sourceFilteringPages && !sourceLoadingMore && !statusesLoading) sourceLoadMore();
  }, [sourceFilteringPages, sourceLoadMore, sourceLoadingMore, statusesLoading]);
  const refresh = () => { if (filter === "running") return discoverRunningSessions(sourceFilter).catch(() => undefined); setCutoff(sessionFilterCutoff(filterPreference.minutes, Date.now())); if (sourceFilter !== "all") sourceSessions.reload(); void loadSessionSourcePreference().catch(() => undefined); return loadSessionFilterMinutes().then(() => refreshHome()).catch(() => undefined); };
  const refreshOnPull = async () => {
    setPullRefreshing(true);
    try {
      await refresh();
    } finally {
      setPullRefreshing(false);
    }
  };

  const openSearchSession = (sessionId: string, target?: SessionNavigationTarget) => {
    router.push({ pathname: "/chat/[sessionId]", params: { sessionId, ...(target?.turn != null ? { turn: String(target.turn) } : {}), ...(target?.turnId ? { turnId: target.turnId } : {}) } });
  };

  const hasActiveFilter = Boolean(trimmedQuery) || filter !== "all" || sourceFilter !== "all";
  const searchEmpty = trimmedQuery.length >= 2 && remoteSearch.query === trimmedQuery && remoteSearch.loading && listItems.length === 0
    ? <View style={{ flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center" }}><ActivityIndicator accessibilityLabel={t("chats.searching")} size="small" color={theme.colors.accent} /></View>
    : <EmptyState icon={hasActiveFilter ? "search" : "messages"} title={hasActiveFilter ? t("chats.empty.matching.title") : t("chats.empty.none.title")} action={hasActiveFilter ? { icon: "x", label: t("chats.action.clearFilters"), onPress: () => { setQuery(""); setFilter("all"); selectSource("all"); } } : undefined} />;

  return (
    <Screen edgeToEdge>
      <EdgeHeader onLayout={onHeaderLayout}>
      <ExpandableSearchBar
        transparent
        title={t("tabs.chats")}
        createLabel={t("chats.action.newChat")}
        query={query}
        onQueryChange={setQuery}
        queryRef={searchRef}
        account={<AccountAvatar />}
        onCreate={() => router.push("/new-chat")}
      />
      <ConnectionBanner state={connectionState} />
      {dataError ? <DataError message={dataError} onRetry={refresh} /> : null}
      </EdgeHeader>
      <LegendList
        ref={listRef}
        data={listItems}
        extraData={rowExtraData}
        estimatedItemSize={76}
        maintainVisibleContentPosition
        onViewableItemsChanged={onViewableItemsChanged}
        keyExtractor={(item) => item.kind === "remote-session" ? `remote-session:${item.hit.sessionId}` : item.kind === "local-session" ? `session:${item.session.id}` : item.kind === "remote-space" ? `remote-space:${item.hit.spaceId}` : `space:${item.space.id}`}
        renderItem={({ item }) => {
          if (item.kind === "remote-session") return <SessionSearchRow hit={item.hit} onPress={(target) => openSearchSession(item.hit.sessionId, target)} onPressIn={() => prefetchSession(item.hit.sessionId)} />;
          if (item.kind === "local-session") return <SessionRow session={item.session} onPress={() => openSearchSession(item.session.id)} onPressIn={() => prefetchSession(item.session.id)} />;
          if (item.kind === "remote-space") return <SpaceSearchRow hit={item.hit} onPress={() => router.push({ pathname: "/space/[spaceId]", params: { spaceId: item.hit.spaceId } })} />;
          return <SpaceRow space={item.space} sessionCount={spaceSessionCounts[item.space.id] ?? null} onPress={() => router.push({ pathname: "/space/[spaceId]", params: { spaceId: item.space.id } })} />;
        }}
        keyboardShouldPersistTaps="handled"
        refreshing={pullRefreshing}
        onRefresh={refreshOnPull}
        onEndReached={() => { if (trimmedQuery || filter === "running") return; if (sourceFilter !== "all") { sourceLoadMore(); return; } if (filter === "all") void loadMoreSessions(); }}
        onEndReachedThreshold={0.7}
        contentInsetAdjustmentBehavior="never"
        progressViewOffset={headerHeight}
        scrollIndicatorInsets={{ top: headerHeight, bottom: tabBarInset }}
        contentContainerStyle={{ paddingTop: headerHeight, paddingBottom: tabBarInset, flexGrow: listItems.length === 0 ? 1 : undefined }}
        ListHeaderComponent={<View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingVertical: 4 }}>
            <FilterChip label={t("chats.filter.all")} selected={filter === "all"} onPress={() => setFilter("all")} />
            <FilterChip label={t("chats.filter.running")} selected={filter === "running"} onPress={() => setFilter("running")} />
            <FilterChip label={t("chats.filter.completed")} selected={filter === "completed"} onPress={() => setFilter("completed")} />
            <View ref={sourceButtonRef} collapsable={false}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("chats.source.filter")}
                accessibilityState={{ expanded: sourceMenuOpen, selected: sourceFilter !== "all" }}
                onPress={() => setSourceMenuOpen(true)}
                style={({ pressed }) => ({ minHeight: 34, width: 38, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: sourceFilter !== "all" ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface, borderWidth: 1, borderColor: sourceFilter !== "all" ? theme.colors.accentBorder : theme.colors.border })}
              >
                <AppIcon name="filter" size={16} color={sourceFilter !== "all" ? theme.colors.accent : theme.colors.textMuted} />
              </Pressable>
            </View>
          </View>
          {filter === "completed" ? <Text style={[typography.caption, { color: theme.colors.textMuted, paddingVertical: 6 }]}>{t("chats.filter.window", { minutes: filterPreference.minutes })}</Text> : null}
          {remoteSearch.query === trimmedQuery && remoteSearch.loading ? <View style={{ alignItems: "flex-end", minHeight: 16 }}><ActivityIndicator accessibilityLabel={t("chats.searching")} size="small" color={theme.colors.accent} /></View> : null}
          {remoteSearch.query === trimmedQuery && remoteSearch.error && trimmedQuery.length >= 2 ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text selectable style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{remoteSearch.error}</Text><IconButton name="refresh" label={t("chats.search.retry")} onPress={remoteSearch.retry} tone="accent" /></View> : null}
        </View>}
        ListEmptyComponent={dataError ? <EmptyState icon="cloud-off" title={t("chats.error.title")} description={t("chats.error.body")} /> : state.booting || (filter === "running" ? !runningQuery.loaded : (filter === "completed" && (state.refreshing || !filterPreference.loaded || statusesLoading || filteringPages)) || (sourceFilter !== "all" && (sourceSessions.loading || !sourceSessions.initialized))) ? <LoadingRows count={5} /> : searchEmpty}
        ListFooterComponent={!dataError && filter !== "running" && (state.sessionsLoadingMore || (filter !== "all" && (statusesLoading || filteringPages)) || (sourceFilter !== "all" && (sourceLoadingMore || (filter !== "all" && (statusesLoading || sourceFilteringPages))))) ? <View style={{ paddingVertical: 18, alignItems: "center" }}><ActivityIndicator accessibilityLabel={t("chats.loadingStatuses")} size="small" color={theme.colors.accent} /></View> : null}
      />
      {sourceMenuOpen ? <AnchoredActionMenu
        anchorRef={sourceButtonRef}
        title={t("chats.source.title")}
        testID="chats-source-menu"
        onClose={() => setSourceMenuOpen(false)}
        actions={[
          { icon: sourceFilter === "all" ? "check" : "messages", title: t("chats.source.all"), onPress: () => selectSource("all") },
          { icon: sourceFilter === "web" ? "check" : "globe", title: t("chats.source.web"), onPress: () => selectSource("web") },
          { icon: sourceFilter === "other" ? "check" : "globe", title: t("chats.source.other"), onPress: () => selectSource("other") },
        ]}
      /> : null}
    </Screen>
  );
}

function FilterChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useAppTheme();
  return <Pressable accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} style={({ pressed }) => ({ minHeight: 34, paddingHorizontal: 13, borderRadius: 999, justifyContent: "center", backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface, borderWidth: 1, borderColor: selected ? theme.colors.accentBorder : theme.colors.border })}><Text style={[typography.caption, { color: selected ? theme.colors.accent : theme.colors.textMuted }]}>{label}</Text></Pressable>;
}
