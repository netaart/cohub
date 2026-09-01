import { useRouter } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from "react-native";
import { SessionRow } from "@/src/components/SessionRow";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { BrandMark, ConnectionBanner, DataError, EmptyState, IconButton, LoadingRows, Screen, SearchField, SyncStatus, TopBar } from "@/src/ui";
import { isNeedsAttentionStatus, isRunningStatus } from "@/src/utils";

type Filter = "all" | "running" | "attention";

export default function ChatsScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const { state, connectionState, refreshHome, loadMoreSessions } = useApp();
  const dataError = state.error ?? state.sessionsError;
  const searchRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const focusSearch = () => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const sessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.sessions.filter((session) => {
      const matchesFilter = filter === "all" || (filter === "running" ? isRunningStatus(session.status) : isNeedsAttentionStatus(session.status));
      if (!matchesFilter) return false;
      if (!needle) return true;
      return [session.title, session.latestMessageText, session.space?.name].some((value) => value?.toLowerCase().includes(needle));
    });
  }, [filter, query, state.sessions]);

  return (
    <Screen>
      <TopBar
        title="Chats"
        subtitle={dataError ? "Chats unavailable" : state.sessions.length > 0 ? `${state.sessions.length} recent threads` : "Your work inbox"}
        left={<BrandMark size={38} />}
        right={<><IconButton name="search" label="Focus search" size={40} onPress={focusSearch} /><IconButton name="square-pen" label="New Chat" size={40} tone="accent" onPress={() => router.push("/new-chat")} /></>}
      />
      <ConnectionBanner state={connectionState} />
      {dataError ? <DataError message={dataError} onRetry={() => void refreshHome()} /> : <SyncStatus timestamp={state.lastSyncedAt} />}
      <FlatList
        ref={listRef}
        data={sessions}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <SessionRow session={item} onPress={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: item.id } })} />}
        keyboardShouldPersistTaps="handled"
        refreshing={state.refreshing}
        onRefresh={() => void refreshHome()}
        onEndReached={() => { if (!query.trim() && filter === "all") void loadMoreSessions(); }}
        onEndReachedThreshold={0.7}
        contentContainerStyle={{ paddingBottom: 30, flexGrow: sessions.length === 0 ? 1 : undefined }}
        ListHeaderComponent={<View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <SearchField inputRef={searchRef} value={query} onChangeText={setQuery} placeholder="Search Chats and Spaces" />
          <View style={{ flexDirection: "row", gap: 8, paddingTop: 12, paddingBottom: 4 }}>
            <FilterChip label="All" selected={filter === "all"} onPress={() => setFilter("all")} />
            <FilterChip label="Running" selected={filter === "running"} onPress={() => setFilter("running")} />
            <FilterChip label="Needs you" selected={filter === "attention"} onPress={() => setFilter("attention")} />
          </View>
        </View>}
        ListEmptyComponent={state.booting ? <LoadingRows count={5} /> : dataError ? <EmptyState icon="cloud-off" title="Chats are unavailable" description="Retry above after checking your connection and sign-in session." /> : <EmptyState icon={query || filter !== "all" ? "search" : "messages"} title={query || filter !== "all" ? "No matching Chats" : "No Chats yet"} description={query || filter !== "all" ? "Try another search or filter." : "Start a focused thread inside one of your Spaces."} action={query || filter !== "all" ? "Clear filters" : "New Chat"} onAction={() => { if (query || filter !== "all") { setQuery(""); setFilter("all"); } else router.push("/new-chat"); }} />}
        ListFooterComponent={state.sessionsLoadingMore ? <View style={{ paddingVertical: 18, alignItems: "center" }}><ActivityIndicator size="small" color={theme.colors.accent} /></View> : null}
      />
    </Screen>
  );
}

function FilterChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useAppTheme();
  return <Pressable onPress={onPress} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ minHeight: 34, paddingHorizontal: 13, borderRadius: 999, justifyContent: "center", backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface, borderWidth: 1, borderColor: selected ? theme.colors.accentBorder : theme.colors.border, transform: [{ scale: pressed ? 0.97 : 1 }] })}><Text style={[typography.caption, { color: selected ? theme.colors.accent : theme.colors.textMuted }]}>{label}</Text></Pressable>;
}
