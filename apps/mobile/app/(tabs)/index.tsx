import { useRouter } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from "react-native";
import { SessionSearchRow, SpaceSearchRow } from "@/src/components/SearchResultRow";
import { SessionRow } from "@/src/components/SessionRow";
import { normalizeSearchQuery, useRemoteSearch, type RemoteSessionSearchHit, type RemoteSpaceSearchHit, type SessionNavigationTarget } from "@/src/data/session-search";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { BrandMark, ConnectionBanner, DataError, EmptyState, IconButton, LoadingRows, Screen, SearchField, SyncStatus, TopBar } from "@/src/ui";
import { isNeedsAttentionStatus, isRunningStatus } from "@/src/utils";
import { SpaceRow } from "@/src/components/SpaceRow";

type Filter = "all" | "running" | "attention";
type ChatListItem =
  | { kind: "local-session"; session: import("@neta-art/cohub").UserSessionListItem }
  | { kind: "remote-session"; hit: RemoteSessionSearchHit }
  | { kind: "local-space"; space: import("@neta-art/cohub").SpaceRecord }
  | { kind: "remote-space"; hit: RemoteSpaceSearchHit };
const CHAT_SEARCH_TYPES = ["session", "turn", "space"] as const;

export default function ChatsScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const { state, client, connectionState, refreshHome, loadMoreSessions } = useApp();
  const dataError = state.error ?? state.sessionsError;
  const searchRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const remoteSearch = useRemoteSearch(client, query, { enabled: filter === "all", types: CHAT_SEARCH_TYPES });
  const trimmedQuery = normalizeSearchQuery(query);

  const focusSearch = () => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const localSessions = useMemo(() => {
    const needle = trimmedQuery.toLowerCase();
    return state.sessions.filter((session) => {
      const matchesFilter = filter === "all" || (filter === "running" ? isRunningStatus(session.status) : isNeedsAttentionStatus(session.status));
      if (!matchesFilter) return false;
      if (!needle) return true;
      return [session.title, session.latestMessageText, session.space?.name].some((value) => value ? normalizeSearchQuery(value).toLowerCase().includes(needle) : false);
    });
  }, [filter, state.sessions, trimmedQuery]);
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

  const openSearchSession = (sessionId: string, target?: SessionNavigationTarget) => {
    router.push({ pathname: "/chat/[sessionId]", params: { sessionId, ...(target?.turn != null ? { turn: String(target.turn) } : {}), ...(target?.turnId ? { turnId: target.turnId } : {}) } });
  };

  const searchEmpty = trimmedQuery.length >= 2 && remoteSearch.query === trimmedQuery && remoteSearch.loading && listItems.length === 0
    ? <View style={{ flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center" }}><ActivityIndicator size="small" color={theme.colors.accent} /><Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 10 }]}>Searching Cohub</Text></View>
    : <EmptyState icon={trimmedQuery || filter !== "all" ? "search" : "messages"} title={trimmedQuery || filter !== "all" ? "No matching Chats" : "No Chats yet"} description={trimmedQuery || filter !== "all" ? "Try another search or filter." : "Start a focused thread inside one of your Spaces."} action={trimmedQuery || filter !== "all" ? "Clear filters" : "New Chat"} onAction={() => { if (trimmedQuery || filter !== "all") { setQuery(""); setFilter("all"); } else router.push("/new-chat"); }} />;

  return (
    <Screen>
      <TopBar title="Chats" subtitle={dataError ? "Chats unavailable" : state.sessions.length > 0 ? `${state.sessions.length} recent threads` : "Your work inbox"} left={<BrandMark size={38} />} right={<><IconButton name="search" label="Focus search" size={40} onPress={focusSearch} /><IconButton name="square-pen" label="New Chat" size={40} tone="accent" onPress={() => router.push("/new-chat")} /></>} />
      <ConnectionBanner state={connectionState} />
      {dataError ? <DataError message={dataError} onRetry={() => void refreshHome()} /> : <SyncStatus timestamp={state.lastSyncedAt} />}
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
        contentContainerStyle={{ paddingBottom: 30, flexGrow: listItems.length === 0 ? 1 : undefined }}
        ListHeaderComponent={<View style={{ paddingHorizontal: 16, paddingTop: 12 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><View style={{ flex: 1 }}><SearchField inputRef={searchRef} value={query} onChangeText={setQuery} placeholder="Search Chats and Spaces" /></View>{remoteSearch.query === trimmedQuery && remoteSearch.loading ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}</View>{remoteSearch.query === trimmedQuery && remoteSearch.error && trimmedQuery.length >= 2 ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 7 }}><Text selectable style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{remoteSearch.error}</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry Chat search" onPress={remoteSearch.retry}><Text style={[typography.micro, { color: theme.colors.accent }]}>Retry</Text></Pressable></View> : null}<View style={{ flexDirection: "row", gap: 8, paddingTop: 12, paddingBottom: 4 }}><FilterChip label="All" selected={filter === "all"} onPress={() => setFilter("all")} /><FilterChip label="Running" selected={filter === "running"} onPress={() => setFilter("running")} /><FilterChip label="Needs you" selected={filter === "attention"} onPress={() => setFilter("attention")} /></View></View>}
        ListEmptyComponent={state.booting ? <LoadingRows count={5} /> : dataError ? <EmptyState icon="cloud-off" title="Chats are unavailable" description="Retry above after checking your connection and sign-in session." /> : searchEmpty}
        ListFooterComponent={state.sessionsLoadingMore ? <View style={{ paddingVertical: 18, alignItems: "center" }}><ActivityIndicator size="small" color={theme.colors.accent} /></View> : null}
      />
    </Screen>
  );
}

function FilterChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useAppTheme();
  return <Pressable onPress={onPress} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ minHeight: 34, paddingHorizontal: 13, borderRadius: 999, justifyContent: "center", backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface, borderWidth: 1, borderColor: selected ? theme.colors.accentBorder : theme.colors.border, transform: [{ scale: pressed ? 0.97 : 1 }] })}><Text style={[typography.caption, { color: selected ? theme.colors.accent : theme.colors.textMuted }]}>{label}</Text></Pressable>;
}
