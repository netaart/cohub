import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from "react-native";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { SpaceSearchRow } from "@/src/components/SearchResultRow";
import { SpaceRow } from "@/src/components/SpaceRow";
import { normalizeSearchQuery, useRemoteSearch, type RemoteSpaceSearchHit } from "@/src/data/session-search";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { BrandMark, DataError, EmptyState, IconButton, LoadingRows, PrimaryButton, SearchField, SyncStatus, TopBar, Screen } from "@/src/ui";
import { displaySpaceName } from "@/src/utils";

type SpaceListItem =
  | { kind: "local"; space: import("@neta-art/cohub").SpaceRecord }
  | { kind: "remote"; hit: RemoteSpaceSearchHit };
const SPACE_SEARCH_TYPES = ["space"] as const;

export default function SpacesScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const { state, client, refreshHome, createSpace } = useApp();
  const dataError = state.error ?? state.spacesError;
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const remoteSearch = useRemoteSearch(client, query, { types: SPACE_SEARCH_TYPES });
  const trimmedQuery = normalizeSearchQuery(query);
  const spaces = useMemo(() => {
    const needle = trimmedQuery.toLowerCase();
    return state.spaces.filter((space) => !needle || [displaySpaceName(space), space.description].some((value) => value ? normalizeSearchQuery(value).toLowerCase().includes(needle) : false));
  }, [state.spaces, trimmedQuery]);
  const listItems = useMemo<SpaceListItem[]>(() => {
    if (!trimmedQuery) return spaces.map((space) => ({ kind: "local", space }));
    const remoteQueryMatches = remoteSearch.query === trimmedQuery;
    const remoteSpaces = remoteQueryMatches ? remoteSearch.spaces : [];
    const remoteIds = new Set(remoteSpaces.map((hit) => hit.spaceId));
    return [
      ...remoteSpaces.map((hit) => ({ kind: "remote" as const, hit })),
      ...spaces.filter((space) => !remoteIds.has(space.id)).map((space) => ({ kind: "local" as const, space })),
    ];
  }, [remoteSearch.query, remoteSearch.spaces, spaces, trimmedQuery]);

  const closeCreate = () => {
    if (!creating) setCreateOpen(false);
  };

  const submitCreate = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const space = await createSpace(name, description);
      setCreateOpen(false);
      setName("");
      setDescription("");
      router.push({ pathname: "/space/[spaceId]", params: { spaceId: space.id } });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Unable to create Space");
    } finally {
      setCreating(false);
    }
  };

  const searchEmpty = remoteSearch.query === trimmedQuery && remoteSearch.loading && trimmedQuery.length >= 2 && listItems.length === 0
    ? <View style={{ flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center" }}><ActivityIndicator size="small" color={theme.colors.accent} /><Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 10 }]}>Searching Cohub</Text></View>
    : <EmptyState icon={trimmedQuery ? "search" : "layers"} title={trimmedQuery ? "No matching Spaces" : "No Spaces yet"} description={trimmedQuery ? "Try another name or description." : "Create a Space first, then start a Chat with an Agent."} action={trimmedQuery ? "Clear search" : "Create Space"} onAction={() => trimmedQuery ? setQuery("") : setCreateOpen(true)} />;

  return <Screen>
    <TopBar title="Spaces" subtitle={dataError ? "Spaces unavailable" : `${state.spaces.length} workspaces`} left={<BrandMark size={36} />} right={<IconButton name="plus" label="New Space" size={38} tone="accent" onPress={() => { setCreateError(null); setCreateOpen(true); }} />} />
    {dataError ? <DataError message={dataError} onRetry={() => void refreshHome()} /> : <SyncStatus timestamp={state.lastSyncedAt} />}
    <FlatList
      data={listItems}
      keyExtractor={(item) => item.kind === "remote" ? `remote-space:${item.hit.spaceId}` : `space:${item.space.id}`}
      renderItem={({ item }) => item.kind === "remote" ? <SpaceSearchRow hit={item.hit} onPress={() => router.push({ pathname: "/space/[spaceId]", params: { spaceId: item.hit.spaceId } })} /> : <SpaceRow space={item.space} chatCount={state.sessions.filter((session) => session.spaceId === item.space.id).length} onPress={() => router.push({ pathname: "/space/[spaceId]", params: { spaceId: item.space.id } })} />}
      refreshing={state.refreshing}
      onRefresh={() => void refreshHome()}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: 30, flexGrow: listItems.length === 0 ? 1 : undefined }}
      ListHeaderComponent={<View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 5 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><View style={{ flex: 1 }}><SearchField value={query} onChangeText={setQuery} placeholder="Find a Space" /></View>{remoteSearch.query === trimmedQuery && remoteSearch.loading ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}</View>{remoteSearch.query === trimmedQuery && remoteSearch.error && trimmedQuery.length >= 2 ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 7 }}><Text selectable style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{remoteSearch.error}</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry Space search" onPress={remoteSearch.retry}><Text style={[typography.micro, { color: theme.colors.accent }]}>Retry</Text></Pressable></View> : null}<Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 16 }]}>Your workspaces</Text></View>}
      ListEmptyComponent={state.booting ? <LoadingRows count={4} /> : dataError ? <EmptyState icon="cloud-off" title="Spaces are unavailable" description="Retry above after checking your connection and sign-in session." /> : searchEmpty}
    />
    <AdaptiveSheet
      visible={createOpen}
      title="Create a Space"
      subtitle="Keep Chats, Files, Saves, and Works together."
      onClose={closeCreate}
      dismissible={!creating}
      testID="create-space-sheet"
      footer={<View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10 }}><Pressable disabled={creating} onPress={closeCreate} style={({ pressed }) => ({ minHeight: 46, paddingHorizontal: 15, justifyContent: "center", opacity: pressed ? 0.6 : 1 })}><Text style={[typography.bodyMedium, { color: theme.colors.textSecondary }]}>Cancel</Text></Pressable><PrimaryButton label="Create Space" icon="plus" loading={creating} disabled={!name.trim()} onPress={() => void submitCreate()} style={{ minHeight: 46, paddingHorizontal: 16 }} /></View>}
    >
      <Text style={[typography.caption, { color: theme.colors.textSecondary, marginBottom: 7 }]}>Name</Text>
      <TextInput autoFocus value={name} onChangeText={setName} maxLength={80} placeholder="e.g. Product launch" placeholderTextColor={theme.colors.textFaint} style={[typography.body, { color: theme.colors.text, minHeight: 48, paddingHorizontal: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.background }]} />
      <Text style={[typography.caption, { color: theme.colors.textSecondary, marginTop: 15, marginBottom: 7 }]}>Description <Text style={{ color: theme.colors.textSecondary }}>(optional)</Text></Text>
      <TextInput value={description} onChangeText={setDescription} maxLength={240} multiline placeholder="What are you working on?" placeholderTextColor={theme.colors.textFaint} style={[typography.body, { color: theme.colors.text, minHeight: 74, paddingHorizontal: 12, paddingTop: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.background, textAlignVertical: "top" }]} />
      {createError ? <Text style={[typography.caption, { color: theme.colors.danger, marginTop: 10 }]}>{createError}</Text> : null}
    </AdaptiveSheet>
  </Screen>;
}
