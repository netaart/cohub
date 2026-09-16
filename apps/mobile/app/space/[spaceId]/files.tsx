import type { SpaceFsEntry } from "@neta-art/cohub";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LegendList } from "@legendapp/list/react-native";
import { Alert, Pressable, Share, Text, View } from "react-native";
import { SpaceFileRow } from "@/src/components/SpaceFileRow";
import { useApp } from "@/src/data/context";
import { useSyncScope } from "@/src/data/use-sync-scope";
import { useSpaceRealtime } from "@/src/data/use-space-realtime";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, TopBar, IconButton, LoadingRows, Screen } from "@/src/ui";
import {
  displaySpaceName,
  normalizeSpacePath,
  parentSpacePath,
  spacePathName,
} from "@/src/utils";

type Params = { spaceId?: string | string[]; path?: string | string[] };

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default function FilesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const spaceId = firstParam(params.spaceId);
  useSpaceRealtime(spaceId ? [spaceId] : []);
  const currentPath = normalizeSpacePath(firstParam(params.path));
  const theme = useAppTheme();
  const { t } = useTranslation();
  const { client, state } = useApp();
  const space = state.spaces.find((item) => item.id === spaceId);
  const [entries, setEntries] = useState<SpaceFsEntry[]>([]);
  const requestIdRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const loadEntries = useCallback(async (options: { silent?: boolean } = {}) => {
    if (inFlightRef.current) return;
    const requestId = ++requestIdRef.current;
    if (!client || !spaceId) {
      setEntries([]);
      setLoading(false);
      setError(spaceId ? t("files.connect") : t("files.spaceUnavailable"));
      return;
    }

    inFlightRef.current = true;
    if (!options.silent) { setLoading(true); setError(null); setEntries([]); }
    try {
      const result = await client.space(spaceId).files.list(currentPath || undefined);
      if (requestId === requestIdRef.current) { setEntries(result.entries); setError(null); }
    } catch (caught) {
      if (requestId === requestIdRef.current) setError(caught instanceof Error ? caught.message : t("files.loadError"));
      if (options.silent) throw caught;
    } finally {
      if (requestId === requestIdRef.current) { inFlightRef.current = false; setLoading(false); }
    }
  }, [client, currentPath, spaceId, t]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void loadEntries();
    });
    return () => {
      active = false;
      requestIdRef.current += 1;
      inFlightRef.current = false;
    };
  }, [loadEntries, refreshToken]);
  useSyncScope(`space:${spaceId}:files:${currentPath}`, () => loadEntries({ silent: true }), 30_000, Boolean(spaceId));

  const openPath = useCallback(
    (path: string) => {
      if (!spaceId) return;
      const normalizedPath = normalizeSpacePath(path);
      router.push({
        pathname: "/space/[spaceId]/files",
        params: normalizedPath ? { spaceId, path: normalizedPath } : { spaceId },
      });
    },
    [router, spaceId],
  );

  const dismissPath = useCallback(
    (path: string) => {
      if (!spaceId) return;
      const normalizedPath = normalizeSpacePath(path);
      router.dismissTo({
        pathname: "/space/[spaceId]/files",
        params: normalizedPath ? { spaceId, path: normalizedPath } : { spaceId },
      });
    },
    [router, spaceId],
  );

  const openEntry = useCallback(
    (entry: SpaceFsEntry) => {
      if (entry.type === "dir") {
        openPath(entry.path);
        return;
      }
      if (!spaceId) return;
      router.push({
        pathname: "/space/[spaceId]/file",
        params: { spaceId, path: entry.path },
      });
    },
    [openPath, router, spaceId],
  );

  const showFileActions = useCallback((entry: SpaceFsEntry) => {
    Alert.alert(entry.name, undefined, [
      { text: t("file.openExternally"), onPress: () => openEntry(entry) },
      { text: "Share", onPress: () => void Share.share({ message: entry.path }).catch(() => undefined) },
      { text: t("common.cancel"), style: "cancel" },
    ]);
  }, [openEntry, t]);

  const goToParent = useCallback(() => {
    dismissPath(parentSpacePath(currentPath));
  }, [currentPath, dismissPath]);

  const title = currentPath ? spacePathName(currentPath) : t("files.title");
  const subtitle = space
    ? currentPath
      ? `${displaySpaceName(space)} / ${currentPath}`
      : displaySpaceName(space)
    : t("files.workspace");

  // LegendList memoizes each row on [item, extraData]; the row's child reads theme/locale,
  // which never change `entries`, so they must flow through extraData.
  const rowExtraData = useMemo(() => ({ t, theme }), [t, theme]);

  return (
    <Screen>
      <TopBar
        title={title}
        subtitle={subtitle}
        onBack={() => router.back()}
        actions={
          <IconButton
            name="refresh"
            label={t("files.refresh")}
            size={40}
            onPress={() => setRefreshToken((value) => value + 1)}
            disabled={loading}
          />
        }
      />
      {currentPath ? (
        <DirectoryParentBar
          parentPath={parentSpacePath(currentPath)}
          onPress={goToParent}
        />
      ) : null}
      {error && entries.length > 0 ? <Text selectable style={[typography.caption, { color: theme.colors.danger, padding: 16 }]}>{error}</Text> : null}
      {loading ? (
        <LoadingRows count={6} />
      ) : error && entries.length === 0 ? (
        <FilesError message={error} onRetry={() => setRefreshToken((value) => value + 1)} />
      ) : (
        <LegendList
          estimatedItemSize={56}
          data={entries}
          extraData={rowExtraData}
          keyExtractor={(item) => item.path}
          contentContainerStyle={{
            paddingVertical: 10,
            paddingBottom: 28,
            flexGrow: entries.length === 0 ? 1 : undefined,
          }}
          renderItem={({ item }) => (
            <SpaceFileRow entry={item} onPress={() => openEntry(item)} onLongPress={() => showFileActions(item)} />
          )}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <AppIcon name="folder-open" size={26} color={theme.colors.textMuted} />
              <Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 10 }]}>
                {currentPath ? t("files.emptyFolder") : t("files.emptyWorkspace")}
              </Text>
              {currentPath ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("files.backToFiles")}
                  onPress={() => dismissPath("")}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, marginTop: 14 })}
                >
                  <Text style={[typography.bodyMedium, { color: theme.colors.accent }]}>{t("files.backToFiles")}</Text>
                </Pressable>
              ) : null}
            </View>
          }
        />
      )}
    </Screen>
  );
}

function DirectoryParentBar({ parentPath, onPress }: { parentPath: string; onPress: () => void }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={parentPath ? t("files.backTo", { name: parentPath }) : t("files.backToFiles")}
      onPress={onPress}
     
      style={({ pressed }) => [
        styles.parentBar,
        { borderBottomColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.background },
      ]}
    >
      <AppIcon name="arrow-left" size={16} color={theme.colors.textMuted} />
      <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textSecondary }]}>
        {parentPath ? t("files.backTo", { name: spacePathName(parentPath) }) : t("files.backToFiles")}
      </Text>
    </Pressable>
  );
}

function FilesError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  return (
    <View style={styles.errorState}>
      <AppIcon name="cloud-off" size={26} color={theme.colors.danger} />
      <Text style={[typography.body, { color: theme.colors.danger, textAlign: "center", marginTop: 10 }]}>
        {message}
      </Text>
      <View style={{ marginTop: 16 }}><IconButton name="refresh" label={t("common.retry")} onPress={onRetry} tone="accent" /></View>
    </View>
  );
}

const styles = {
  parentBar: {
    minHeight: 42,
    paddingHorizontal: 16,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    borderBottomWidth: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: 24,
  },
  errorState: {
    flex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: 24,
  },
} satisfies Record<string, object>;
