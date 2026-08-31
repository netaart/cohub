import type { SpaceFsEntry } from "@neta-art/cohub";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { SpaceFileRow } from "@/src/components/SpaceFileRow";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, DetailTopBar, IconButton, LoadingRows, PrimaryButton, Screen } from "@/src/ui";
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
  const currentPath = normalizeSpacePath(firstParam(params.path));
  const theme = useAppTheme();
  const { client, state } = useApp();
  const space = state.spaces.find((item) => item.id === spaceId);
  const [entries, setEntries] = useState<SpaceFsEntry[]>([]);
  const requestIdRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!client || !spaceId) {
      setEntries([]);
      setLoading(false);
      setError(spaceId ? "Connect to Cohub to browse Files." : "Space is unavailable.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await client.space(spaceId).files.list(currentPath || undefined);
      if (requestId === requestIdRef.current) setEntries(result.entries);
    } catch (caught) {
      if (requestId === requestIdRef.current) setError(caught instanceof Error ? caught.message : "Unable to load Files");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [client, currentPath, spaceId]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void loadEntries();
    });
    return () => {
      active = false;
      requestIdRef.current += 1;
    };
  }, [loadEntries, refreshToken]);

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

  const goToParent = useCallback(() => {
    dismissPath(parentSpacePath(currentPath));
  }, [currentPath, dismissPath]);

  const title = currentPath ? spacePathName(currentPath) : "Files";
  const subtitle = space
    ? currentPath
      ? `${displaySpaceName(space)} / ${currentPath}`
      : displaySpaceName(space)
    : "Space workspace";

  return (
    <Screen>
      <DetailTopBar
        title={title}
        subtitle={subtitle}
        onBack={() => router.back()}
        actions={
          <IconButton
            name="refresh"
            label="Refresh files"
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
      {loading ? (
        <LoadingRows count={6} />
      ) : error ? (
        <FilesError message={error} onRetry={() => setRefreshToken((value) => value + 1)} />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.path}
          contentContainerStyle={{
            paddingVertical: 10,
            paddingBottom: 28,
            flexGrow: entries.length === 0 ? 1 : undefined,
          }}
          renderItem={({ item }) => (
            <SpaceFileRow entry={item} onPress={() => openEntry(item)} />
          )}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <AppIcon name="folder-open" size={26} color={theme.colors.textMuted} />
              <Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 10 }]}>
                {currentPath ? "This folder is empty." : "This workspace is empty."}
              </Text>
              {currentPath ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Back to Files"
                  onPress={() => dismissPath("")}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, marginTop: 14 })}
                >
                  <Text style={[typography.bodyMedium, { color: theme.colors.accent }]}>Back to Files</Text>
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={parentPath ? `Back to ${parentPath}` : "Back to Files"}
      onPress={onPress}
      android_ripple={{ color: theme.colors.pressOverlay }}
      style={({ pressed }) => [
        styles.parentBar,
        { borderBottomColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.background },
      ]}
    >
      <AppIcon name="arrow-left" size={16} color={theme.colors.textMuted} />
      <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textSecondary }]}>
        {parentPath ? `Back to ${spacePathName(parentPath)}` : "Back to Files"}
      </Text>
    </Pressable>
  );
}

function FilesError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const theme = useAppTheme();
  return (
    <View style={styles.errorState}>
      <AppIcon name="cloud-off" size={26} color={theme.colors.danger} />
      <Text style={[typography.body, { color: theme.colors.danger, textAlign: "center", marginTop: 10 }]}>
        {message}
      </Text>
      <PrimaryButton label="Retry" icon="refresh" onPress={onRetry} style={{ marginTop: 16 }} />
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
