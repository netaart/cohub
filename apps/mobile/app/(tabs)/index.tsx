import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { SessionRow } from "@/src/components/SessionRow";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, BrandMark, ConnectionBanner, EmptyState, IconButton, LoadingRows, SearchField, TopBar } from "@/src/ui";
import { isNeedsAttentionStatus, isRunningStatus } from "@/src/utils";

type Filter = "all" | "running" | "attention";

export default function ChatsScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const { state, connectionState, refreshHome } = useApp();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

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
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <TopBar
        title="Chats"
        subtitle={state.sessions.length > 0 ? `${state.sessions.length} recent threads` : "Your work inbox"}
        left={<BrandMark size={36} />}
        right={<><IconButton name="search-outline" label="Focus search" size={38} onPress={() => setQuery((value) => value || " ")} /><IconButton name="create-outline" label="New Chat" size={38} tone="accent" onPress={() => router.push("/new-chat")} /></>}
      />
      <ConnectionBanner state={connectionState} />
      <FlatList
        data={sessions}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <SessionRow session={item} onPress={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: item.id } })} />}
        keyboardShouldPersistTaps="handled"
        refreshing={state.refreshing}
        onRefresh={() => void refreshHome()}
        contentContainerStyle={{ paddingBottom: 30, flexGrow: sessions.length === 0 ? 1 : undefined }}
        ListHeaderComponent={<View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
          <SearchField value={query.trim()} onChangeText={setQuery} placeholder="Search Chats and Spaces" />
          <View style={{ flexDirection: "row", gap: 8, paddingTop: 12 }}>
            <FilterChip label="All" selected={filter === "all"} onPress={() => setFilter("all")} />
            <FilterChip label="Running" selected={filter === "running"} onPress={() => setFilter("running")} />
            <FilterChip label="Needs you" selected={filter === "attention"} onPress={() => setFilter("attention")} />
          </View>
          {state.error ? <Pressable onPress={() => void refreshHome()} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14, padding: 11, borderRadius: 12, backgroundColor: theme.colors.dangerSoft }}><AppIcon name="alert-circle-outline" size={16} color={theme.colors.danger} /><Text style={[typography.caption, { color: theme.colors.danger, flex: 1 }]}>{state.error}</Text><Text style={[typography.caption, { color: theme.colors.danger }]}>Retry</Text></Pressable> : null}
        </View>}
        ListEmptyComponent={state.booting ? <LoadingRows count={5} /> : <EmptyState icon={query || filter !== "all" ? "search-outline" : "chatbubbles-outline"} title={query || filter !== "all" ? "No matching Chats" : "No Chats yet"} description={query || filter !== "all" ? "Try another search or filter." : "Start a focused thread inside one of your Spaces."} action={query || filter !== "all" ? "Clear filters" : "New Chat"} onAction={() => { if (query || filter !== "all") { setQuery(""); setFilter("all"); } else router.push("/new-chat"); }} />}
      />
    </View>
  );
}

function FilterChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useAppTheme();
  return <Pressable onPress={onPress} style={({ pressed }) => ({ minHeight: 34, paddingHorizontal: 13, borderRadius: 999, justifyContent: "center", backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface, borderWidth: 1, borderColor: selected ? theme.colors.accentBorder : theme.colors.border })}><Text style={[typography.caption, { color: selected ? theme.colors.accent : theme.colors.textMuted }]}>{label}</Text></Pressable>;
}
