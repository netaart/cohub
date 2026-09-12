import { useFocusEffect, useRouter, useScrollToTop } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View, type ViewToken } from "react-native";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { useFloatingTabBarInset } from "@/src/components/FloatingTabBar";
import { AccountAvatar } from "@/src/components/AccountAvatar";
import { SpaceSearchRow } from "@/src/components/SearchResultRow";
import { SpaceRow } from "@/src/components/SpaceRow";
import { normalizeSearchQuery, useRemoteSearch, type RemoteSpaceSearchHit } from "@/src/data/session-search";
import { useSpaceSessionCounts } from "@/src/data/space-session-counts";
import { selectSpaceList, type SpaceListSpace, type SpaceFilter } from "@/src/data/space-list";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { useTranslation } from "@/src/i18n";
import { AppIcon, DataError, EmptyState, ExpandableSearchBar, IconButton, LoadingRows, PrimaryButton, Screen } from "@/src/ui";
import { displaySpaceName } from "@/src/utils";

type SpaceListItem =
  | { kind: "local"; space: SpaceListSpace }
  | { kind: "remote"; hit: RemoteSpaceSearchHit };
const SPACE_SEARCH_TYPES = ["space"] as const;

export default function SpacesScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const tabBarInset = useFloatingTabBarInset();
  const { state, client, refreshHome, createSpace, toggleSpacePin, spaceList, userUuid } = useApp();
  const dataError = state.error ?? state.spacesError ?? spaceList.error;
  const refreshSpaceList = spaceList.refresh;
  const [now, setNow] = useState(Date.now);
  useFocusEffect(useCallback(() => { setNow(Date.now()); void refreshSpaceList(); }, [refreshSpaceList]));
  const [query, setQuery] = useState("");
  const listRef = useRef<FlatList<SpaceListItem>>(null);
  useScrollToTop(listRef);
  const [filter, setFilter] = useState<SpaceFilter>("recent");
  const [pinningSpaceId, setPinningSpaceId] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const remoteSearch = useRemoteSearch(client, query, { enabled: filter !== "pinned", types: SPACE_SEARCH_TYPES });
  const trimmedQuery = normalizeSearchQuery(query);
  const spaces = useMemo(() => {
    const needle = trimmedQuery.toLowerCase();
    const personalActivity = new Map<string, number>();
    for (const view of Object.values(state.sessionViews)) {
      if (!view.session) continue;
      for (const turn of view.turns) {
        if (turn.userUuid !== userUuid) continue;
        personalActivity.set(view.session.spaceId, Math.max(personalActivity.get(view.session.spaceId) ?? 0, Date.parse(turn.createdAt)));
      }
    }
    const candidates = selectSpaceList({ spaces: state.spaces, sessions: state.sessions, overview: spaceList.overview, visits: spaceList.visits, personalActivity, filter: filter === "recent" && trimmedQuery ? "all" : filter, now });
    return candidates.filter((space) => !needle || [displaySpaceName(space), space.description].some((value) => value ? normalizeSearchQuery(value).toLowerCase().includes(needle) : false));
  }, [filter, now, state.spaces, state.sessions, state.sessionViews, spaceList.overview, spaceList.visits, trimmedQuery, userUuid]);
  const [visibleSpaceIds, setVisibleSpaceIds] = useState<string[]>([]);
  const visibleSpaceKeyRef = useRef("");
  const onViewableItemsChanged = useCallback((info: { viewableItems: ViewToken<SpaceListItem>[] }) => {
    const ids = info.viewableItems.flatMap((token) => (token.item?.kind === "local" ? [token.item.space.id] : []));
    const key = ids.join(",");
    if (key === visibleSpaceKeyRef.current) return;
    visibleSpaceKeyRef.current = key;
    setVisibleSpaceIds(ids);
  }, []);
  const viewabilityConfig = useMemo(() => ({ itemVisiblePercentThreshold: 25 }), []);
  const spaceById = useMemo(() => new Map(spaces.map((space) => [space.id, space])), [spaces]);
  const countSpaceIds = useMemo(() => visibleSpaceIds.filter((id) => !spaceById.get(id)?.description?.trim()), [spaceById, visibleSpaceIds]);
  const spaceSessionCounts = useSpaceSessionCounts(client, countSpaceIds);
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

  const togglePin = async (spaceId: string) => {
    if (pinningSpaceId) return;
    setPinningSpaceId(spaceId);
    setPinError(null);
    try {
      await toggleSpacePin(spaceId);
    } catch (error) {
      setPinError(error instanceof Error ? error.message : t("spaces.pin.error"));
    } finally {
      setPinningSpaceId(null);
    }
  };

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
      setCreateError(error instanceof Error ? error.message : t("spaces.create.error"));
    } finally {
      setCreating(false);
    }
  };

  const searchEmpty = remoteSearch.query === trimmedQuery && remoteSearch.loading && trimmedQuery.length >= 2 && listItems.length === 0
    ? <View style={{ flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center" }}><ActivityIndicator accessibilityLabel={t("spaces.searching")} size="small" color={theme.colors.accent} /></View>
    : <EmptyState icon={filter === "pinned" ? "pin" : trimmedQuery ? "search" : "layers"} title={filter === "pinned" ? t("spaces.empty.pinned.title") : trimmedQuery ? t("spaces.empty.matching.title") : t("spaces.empty.none.title")} action={filter === "pinned" || trimmedQuery ? { icon: "x", label: t("spaces.action.clearFilters"), onPress: () => { setFilter("recent"); setQuery(""); } } : undefined} />;

  return <Screen>
    <ExpandableSearchBar
      title={t("tabs.spaces")}
      createLabel={t("spaces.action.create")}
      query={query}
      onQueryChange={setQuery}
      placeholder={t("spaces.search.placeholder")}
      account={<AccountAvatar />}
      onCreate={() => { setCreateError(null); setCreateOpen(true); }}
    />
    {dataError ? <DataError message={dataError} onRetry={() => void Promise.all([refreshHome(), spaceList.refresh()])} /> : null}
    <FlatList
      ref={listRef}
      data={listItems}
      keyExtractor={(item) => item.kind === "remote" ? `remote-space:${item.hit.spaceId}` : `space:${item.space.id}`}
      renderItem={({ item }) => item.kind === "remote" ? <SpaceSearchRow hit={item.hit} onPress={() => router.push({ pathname: "/space/[spaceId]", params: { spaceId: item.hit.spaceId } })} /> : <SpaceRow space={item.space} sessionCount={spaceSessionCounts[item.space.id] ?? null} pinning={pinningSpaceId === item.space.id} onTogglePin={client ? () => void togglePin(item.space.id) : undefined} onPress={() => router.push({ pathname: "/space/[spaceId]", params: { spaceId: item.space.id } })} />}
      refreshing={state.refreshing || (filter === "recent" && spaceList.loading)}
      onRefresh={() => void Promise.all([refreshHome(), spaceList.refresh()])}
      viewabilityConfig={viewabilityConfig}
      onViewableItemsChanged={onViewableItemsChanged}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: tabBarInset, flexGrow: listItems.length === 0 ? 1 : undefined }}
      ListHeaderComponent={<View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingVertical: 4 }}>
          <SpaceFilterChip label={t("spaces.filter.recent")} selected={filter === "recent"} onPress={() => setFilter("recent")} />
          <SpaceFilterChip label={t("spaces.filter.all")} selected={filter === "all"} onPress={() => setFilter("all")} />
          <SpaceFilterChip label={t("spaces.filter.pinned")} icon="pin" selected={filter === "pinned"} onPress={() => setFilter("pinned")} />
        </View>
        {remoteSearch.query === trimmedQuery && remoteSearch.loading ? <View style={{ alignItems: "flex-end", minHeight: 16 }}><ActivityIndicator accessibilityLabel={t("spaces.searching")} size="small" color={theme.colors.accent} /></View> : null}
        {remoteSearch.query === trimmedQuery && remoteSearch.error && trimmedQuery.length >= 2 ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text selectable style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{remoteSearch.error}</Text><IconButton name="refresh" label={t("spaces.search.retry")} onPress={remoteSearch.retry} tone="accent" /></View> : null}
        {pinError ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text selectable style={[typography.micro, { color: theme.colors.danger, flex: 1 }]}>{pinError}</Text><IconButton name="x" label={t("spaces.pin.dismiss")} onPress={() => setPinError(null)} /></View> : null}
      </View>}
      ListEmptyComponent={state.booting || (filter === "recent" && spaceList.loading) ? <LoadingRows count={4} /> : dataError ? <EmptyState icon="cloud-off" title={t("spaces.error.title")} description={t("spaces.error.body")} /> : searchEmpty}
    />
    <AdaptiveSheet
      visible={createOpen}
      title={t("spaces.create.title")}
      onClose={closeCreate}
      dismissible={!creating}
      testID="create-space-sheet"
      footer={<PrimaryButton label={t("spaces.create.action")} icon="plus" loading={creating} disabled={!name.trim()} onPress={() => void submitCreate()} />}
    >
      <Text style={[typography.caption, { color: theme.colors.textSecondary, marginBottom: 7 }]}>{t("spaces.create.name")}</Text>
      <TextInput autoFocus value={name} onChangeText={setName} maxLength={80} placeholder={t("spaces.create.namePlaceholder")} placeholderTextColor={theme.colors.textFaint} style={[typography.body, { color: theme.colors.text, minHeight: 48, paddingHorizontal: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.background }]} />
      <Text style={[typography.caption, { color: theme.colors.textSecondary, marginTop: 15, marginBottom: 7 }]}>{t("spaces.create.description")} <Text style={{ color: theme.colors.textSecondary }}>({t("common.optional")})</Text></Text>
      <TextInput value={description} onChangeText={setDescription} maxLength={240} multiline placeholder={t("spaces.create.descriptionPlaceholder")} placeholderTextColor={theme.colors.textFaint} style={[typography.body, { color: theme.colors.text, minHeight: 74, paddingHorizontal: 12, paddingTop: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.background, textAlignVertical: "top" }]} />
      {createError ? <Text style={[typography.caption, { color: theme.colors.danger, marginTop: 10 }]}>{createError}</Text> : null}
    </AdaptiveSheet>
  </Screen>;
}

function SpaceFilterChip({ label, icon, selected, onPress }: { label: string; icon?: React.ComponentProps<typeof AppIcon>["name"]; selected: boolean; onPress: () => void }) {
  const theme = useAppTheme();
  return <Pressable accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} style={({ pressed }) => ({ height: 34, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: selected ? theme.colors.accentBorder : theme.colors.border, backgroundColor: selected ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface, flexDirection: "row", alignItems: "center", gap: 5 })}>{icon ? <AppIcon name={icon} size={13} color={selected ? theme.colors.accent : theme.colors.textMuted} /> : null}<Text style={[typography.caption, { color: selected ? theme.colors.accent : theme.colors.textMuted }]}>{label}</Text></Pressable>;
}
