import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import { SpaceRow } from "@/src/components/SpaceRow";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { BrandMark, DataError, EmptyState, IconButton, LoadingRows, PrimaryButton, SearchField, SyncStatus, TopBar, Screen } from "@/src/ui";
import { displaySpaceName } from "@/src/utils";

export default function SpacesScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const { state, refreshHome, createSpace } = useApp();
  const dataError = state.error ?? state.spacesError;
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const spaces = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.spaces.filter((space) => !needle || [displaySpaceName(space), space.description].some((value) => value?.toLowerCase().includes(needle)));
  }, [query, state.spaces]);
  return <Screen>
    <TopBar title="Spaces" subtitle={dataError ? "Spaces unavailable" : `${state.spaces.length} workspaces`} left={<BrandMark size={36} />} right={<IconButton name="add" label="New Space" size={38} tone="accent" onPress={() => { setCreateError(null); setCreateOpen(true); }} />} />
    {dataError ? <DataError message={dataError} onRetry={() => void refreshHome()} /> : <SyncStatus timestamp={state.lastSyncedAt} />}
    <FlatList
      data={spaces}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <SpaceRow space={item} chatCount={state.sessions.filter((session) => session.spaceId === item.id).length} onPress={() => router.push({ pathname: "/space/[spaceId]", params: { spaceId: item.id } })} />}
      refreshing={state.refreshing}
      onRefresh={() => void refreshHome()}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: 30, flexGrow: spaces.length === 0 ? 1 : undefined }}
      ListHeaderComponent={<View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 5 }}><SearchField value={query} onChangeText={setQuery} placeholder="Find a Space" /><Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 16 }]}>Your workspaces</Text></View>}
      ListEmptyComponent={state.booting ? <LoadingRows count={4} /> : dataError ? <EmptyState icon="cloud-offline-outline" title="Spaces are unavailable" description="Retry above after checking your connection and sign-in session." /> : <EmptyState icon="layers-outline" title={query ? "No matching Spaces" : "No Spaces yet"} description={query ? "Try another name or description." : "Create a Space first, then start a Chat with an Agent."} action={query ? "Clear search" : "Create Space"} onAction={() => query ? setQuery("") : setCreateOpen(true)} />}
    />
    <Modal visible={createOpen} transparent animationType="slide" onRequestClose={() => setCreateOpen(false)}>
      <Pressable style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" }} onPress={() => setCreateOpen(false)}>
        <Pressable onPress={(event) => event.stopPropagation()} style={{ padding: 18, paddingBottom: 30, borderTopLeftRadius: 22, borderTopRightRadius: 22, backgroundColor: theme.colors.surface }}>
          <View style={{ width: 34, height: 4, borderRadius: 2, alignSelf: "center", backgroundColor: theme.colors.borderStrong, marginBottom: 18 }} />
          <Text style={[typography.title, { color: theme.colors.text }]}>Create a Space</Text>
          <Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 5 }]}>A Space keeps Chats, Files, Saves, and Works together.</Text>
          <Text style={[typography.caption, { color: theme.colors.textSecondary, marginTop: 20, marginBottom: 7 }]}>Name</Text>
          <TextInput autoFocus value={name} onChangeText={setName} maxLength={80} placeholder="e.g. Product launch" placeholderTextColor={theme.colors.textFaint} style={[typography.body, { color: theme.colors.text, minHeight: 48, paddingHorizontal: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.background }]} />
          <Text style={[typography.caption, { color: theme.colors.textSecondary, marginTop: 15, marginBottom: 7 }]}>Description <Text style={{ color: theme.colors.textFaint }}>(optional)</Text></Text>
          <TextInput value={description} onChangeText={setDescription} maxLength={240} multiline placeholder="What are you working on?" placeholderTextColor={theme.colors.textFaint} style={[typography.body, { color: theme.colors.text, minHeight: 74, paddingHorizontal: 12, paddingTop: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.background, textAlignVertical: "top" }]} />
          {createError ? <Text style={[typography.caption, { color: theme.colors.danger, marginTop: 10 }]}>{createError}</Text> : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 18 }}><Pressable disabled={creating} onPress={() => setCreateOpen(false)} style={{ minHeight: 46, paddingHorizontal: 15, justifyContent: "center" }}><Text style={[typography.bodyMedium, { color: theme.colors.textMuted }]}>Cancel</Text></Pressable><PrimaryButton label="Create Space" icon="add" loading={creating} disabled={!name.trim()} onPress={() => void (async () => { setCreating(true); setCreateError(null); try { const space = await createSpace(name, description); setCreateOpen(false); setName(""); setDescription(""); router.push({ pathname: "/space/[spaceId]", params: { spaceId: space.id } }); } catch (error) { setCreateError(error instanceof Error ? error.message : "Unable to create Space"); } finally { setCreating(false); } })()} style={{ minHeight: 46, paddingHorizontal: 16 }} /></View>
        </Pressable>
      </Pressable>
    </Modal>
  </Screen>;
}
