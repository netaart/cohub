import { useIsFocused, useRouter, useScrollToTop } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from "react-native";
import { AccountAvatar } from "@/src/components/AccountAvatar";
import { useFloatingTabBarInset } from "@/src/components/FloatingTabBar";
import { SessionSearchRow, SpaceSearchRow } from "@/src/components/SearchResultRow";
import { SessionRow } from "@/src/components/SessionRow";
import { normalizeSearchQuery, useRemoteSearch, type RemoteSessionSearchHit, type RemoteSpaceSearchHit, type SessionNavigationTarget } from "@/src/data/session-search";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { ConnectionBanner, DataError, EmptyState, ExpandableSearchBar, LoadingRows, Screen } from "@/src/ui";
import { getSessionStatus } from "@/src/data/session-status";
import { SpaceRow } from "@/src/components/SpaceRow";

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
  const tabBarInset = useFloatingTabBarInset();
  const isFocused = useIsFocused();
  const { state, client, connectionState, refreshHome, refreshSessionStatuses, loadMoreSessions } = useApp();
  const dataError = state.error ?? state.sessionsError ?? state.sessionStatusError;
  const searchRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<ChatListItem>>(null);
  useScrollToTop(listRef);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const remoteSearch = useRemoteSearch(client, query, { enabled: filter === "all", types: CHAT_SEARCH_TYPES });
  const trimmedQuery = normalizeSearchQuery(query);

  const localSessions = useMemo(() => {
    const needle = trimmedQuery.toLowerCase();
    return state.sessions.filter((session) => {
      const matchesFilter = filter === "all" || getSessionStatus(state.sessionLatestTurns[session.id]?.status) === filter;
      if (!matchesFilter) return false;
      if (!needle) return true;
      return [session.title, session.latestMessageText, session.space?.name].some((value) => value ? normalizeSearchQuery(value).toLowerCase().includes(needle) : false);
    });
  }, [filter, state.sessionLatestTurns, state.sessions, trimmedQuery]);
  const localSpaces = useMemo(() => {
    if (filter !== "all" || !trimmedQuery) return [];
    const needle = trimmedQuery.toLowerCase();
    return state.spaces.filter((space) => [space.name, space.title, space.description].some((value) => value ? normalizeSearchQuery(value).toLowerCase().includes(needle) : false));
  }, [filter, state.spaces, trimmedQuery]);
  const listItems = useMemo<ChatListItem[]>(() => {
    if (!trimmedQuery || filter !== "all") return localSessions.map((session) => ({ kind: "local-session", session }));
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
  }, [filter, localSessions, localSpaces, remoteSearch.query, remoteSearch.sessions, remoteSearch.spaces, trimmedQuery]);

  const filteringPages = isFocused && filter !== "all" && state.sessionsHasMore && !dataError;
  const statusesLoading = state.sessionStatusRequests > 0;
  useEffect(() => {
    if (filteringPages && !state.refreshing && !state.sessionsLoadingMore && !statusesLoading) void loadMoreSessions();
  }, [filteringPages, loadMoreSessions, state.refreshing, state.sessionsCursor, state.sessionsLoadingMore, statusesLoading]);

  const openSearchSession = (sessionId: string, target?: SessionNavigationTarget) => {
    router.push({ pathname: "/chat/[sessionId]", params: { sessionId, ...(target?.turn != null ? { turn: String(target.turn) } : {}), ...(target?.turnId ? { turnId: target.turnId } : {}) } });
  };

  const searchEmpty = trimmedQuery.length >= 2 && remoteSearch.query === trimmedQuery && remoteSearch.loading && listItems.length === 0
    ? <View style={{ flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center" }}><ActivityIndicator size="small" color={theme.colors.accent} /><Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 10 }]}>Searching Cohub</Text></View>
    : <EmptyState icon={trimmedQuery || filter !== "all" ? "search" : "messages"} title={trimmedQuery || filter !== "all" ? "No matching Chats" : "No Chats yet"} description={trimmedQuery || filter !== "all" ? "Try another search or filter." : "Start a focused thread inside one of your Spaces."} action={trimmedQuery || filter !== "all" ? "Clear filters" : "New Chat"} onAction={() => { if (trimmedQuery || filter !== "all") { setQuery(""); setFilter("all"); } else router.push("/new-chat"); }} />;

  return (
    <Screen>
      <ExpandableSearchBar
        query={query}
        onQueryChange={setQuery}
        queryRef={searchRef}
        account={<AccountAvatar />}
        onCreate={() => router.push("/new-chat")}
      />
      <ConnectionBanner state={connectionState} />
      {dataError ? <DataError message={dataError} onRetry={() => void refreshHome()} /> : null}
      <FlatList
        ref={listRef}
        data={listItems}
        keyExtractor={(item) => item.kind === "remote-session" ? `remote-session:${item.hit.sessionId}` : item.kind === "local-session" ? `session:${item.session.id}` : item.kind === "remote-space" ? `remote-space:${item.hit.spaceId}` : `space:${item.space.id}`}
        renderItem={({ item }) => {
          if (item.kind === "remote-session") return <SessionSearchRow hit={item.hit} onPress={(target) => openSearchSession(item.hit.sessionId, target)} />;
          if (item.kind === "local-session") return <SessionRow session={item.session} onPress={() => openSearchSession(item.session.id)} />;
          if (item.kind === "remote-space") return <SpaceSearchRow hit={item.hit} onPress={() => router.push({ pathname: "/space/[spaceId]", params: { spaceId: item.hit.spaceId } })} />;
          return <SpaceRow space={item.space} chatCount={state.sessions.filter((session) => session.spaceId === item.space.id).length} onPress={() => router.push({ pathname: "/space/[spaceId]", params: { spaceId: item.space.id } })} />;
        }}
        keyboardShouldPersistTaps="handled"
        refreshing={state.refreshing}
        onRefresh={() => void refreshHome()}
        onEndReached={() => { if (!trimmedQuery && filter === "all") void loadMoreSessions(); }}
        onEndReachedThreshold={0.7}
        contentContainerStyle={{ paddingBottom: tabBarInset, flexGrow: listItems.length === 0 ? 1 : undefined }}
        ListHeaderComponent={<View style={{ paddingHorizontal: 16, paddingTop: 12 }}>{remoteSearch.query === trimmedQuery && remoteSearch.loading ? <View style={{ alignItems: "flex-end", minHeight: 16 }}><ActivityIndicator size="small" color={theme.colors.accent} /></View> : null}{remoteSearch.query === trimmedQuery && remoteSearch.error && trimmedQuery.length >= 2 ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 7 }}><Text selectable style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{remoteSearch.error}</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry Chat search" onPress={remoteSearch.retry}><Text style={[typography.micro, { color: theme.colors.accent }]}>Retry</Text></Pressable></View> : null}<View style={{ flexDirection: "row", gap: 8, paddingTop: 12, paddingBottom: 4 }}><FilterChip label="All" selected={filter === "all"} onPress={() => setFilter("all")} /><FilterChip label="Running" selected={filter === "running"} onPress={() => { setFilter("running"); void refreshSessionStatuses(state.sessions); }} /><FilterChip label="Completed" selected={filter === "completed"} onPress={() => setFilter("completed")} /></View></View>}
        ListEmptyComponent={state.booting || (filter !== "all" && (statusesLoading || filteringPages)) ? <LoadingRows count={5} /> : dataError ? <EmptyState icon="cloud-off" title="Chats are unavailable" description="Retry above after checking your connection and sign-in session." /> : searchEmpty}
        ListFooterComponent={state.sessionsLoadingMore || statusesLoading || filteringPages ? <View style={{ paddingVertical: 18, alignItems: "center" }}><ActivityIndicator accessibilityLabel="Loading Chat statuses" size="small" color={theme.colors.accent} /></View> : null}
      />
    </Screen>
  );
}

function FilterChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useAppTheme();
  return <Pressable accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} style={({ pressed }) => ({ minHeight: 34, paddingHorizontal: 13, borderRadius: 999, justifyContent: "center", backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface, borderWidth: 1, borderColor: selected ? theme.colors.accentBorder : theme.colors.border })}><Text style={[typography.caption, { color: selected ? theme.colors.accent : theme.colors.textMuted }]}>{label}</Text></Pressable>;
}
