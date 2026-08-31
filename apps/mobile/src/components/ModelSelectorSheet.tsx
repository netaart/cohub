import type { ModelCatalogEntry } from "@neta-art/cohub";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import type { ChatModelSelection } from "@/src/data/types";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, SearchField } from "@/src/ui";

export type ModelSelectorSheetProps = {
  visible: boolean;
  models: ModelCatalogEntry[];
  loading: boolean;
  error: string | null;
  currentModel: ChatModelSelection | null;
  onClose: () => void;
  onRetry: () => void;
  onSelect: (model: ChatModelSelection | null) => void;
};

function modelName(entry: ModelCatalogEntry) {
  const name = entry.model?.name;
  return typeof name === "string" && name.trim() ? name.trim() : entry.id;
}

function modelDescription(entry: ModelCatalogEntry) {
  const context = entry.model?.contextWindow;
  if (typeof context === "number" && Number.isFinite(context)) {
    return `${entry.provider} · ${entry.id} · ${formatTokenCount(context)} context`;
  }
  return `${entry.provider} · ${entry.id}`;
}

function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

export function ModelSelectorSheet({
  visible,
  models,
  loading,
  error,
  currentModel,
  onClose,
  onRetry,
  onSelect,
}: ModelSelectorSheetProps) {
  const theme = useAppTheme();
  const [query, setQuery] = useState("");

  const visibleModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return models
      .filter((entry) => entry.model?.hidden !== true)
      .filter((entry) => {
        if (!needle) return true;
        return [entry.provider, entry.id, modelName(entry)].some((value) =>
          value.toLowerCase().includes(needle),
        );
      });
  }, [models, query]);

  const isCurrent = (entry: ModelCatalogEntry) =>
    currentModel?.provider === entry.provider && currentModel.id === entry.id;

  return (
    <AdaptiveSheet
      visible={visible}
      title="Choose a model"
      subtitle="The selection applies to your next message."
      onClose={onClose}
      testID="chat-model-selector-sheet"
    >
      <SearchField value={query} onChangeText={setQuery} placeholder="Search models" />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Use automatic model selection"
        accessibilityState={{ selected: currentModel === null }}
        onPress={() => onSelect(null)}
        android_ripple={{ color: theme.colors.pressOverlay }}
        style={({ pressed }) => ({
          minHeight: 62,
          marginTop: 12,
          paddingHorizontal: 10,
          borderRadius: 12,
          flexDirection: "row",
          alignItems: "center",
          gap: 11,
          backgroundColor: pressed
            ? theme.colors.surfacePressed
            : currentModel === null
              ? theme.colors.accentSoft
              : "transparent",
          borderWidth: currentModel === null ? 1 : 0,
          borderColor: theme.colors.accentBorder,
        })}
      >
        <View style={[styles.modelIcon, { backgroundColor: theme.colors.surfaceRaised }]}>
          <AppIcon name="sparkles" size={18} color={theme.colors.accent} />
        </View>
        <View style={styles.modelText}>
          <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>Automatic</Text>
          <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>Let Cohub choose an available model</Text>
        </View>
        {currentModel === null ? <AppIcon name="check" size={18} color={theme.colors.accent} /> : null}
      </Pressable>

      <View style={{ marginTop: 10 }}>
        {loading && visibleModels.length === 0 ? (
          <View style={styles.centerState}>
            <ActivityIndicator size="small" color={theme.colors.accent} />
            <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 9 }]}>Loading models…</Text>
          </View>
        ) : error && visibleModels.length === 0 ? (
          <View style={styles.centerState}>
            <AppIcon name="cloud-off" size={24} color={theme.colors.danger} />
            <Text style={[typography.body, { color: theme.colors.danger, textAlign: "center", marginTop: 9 }]}>{error}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading models"
              onPress={onRetry}
              style={({ pressed }) => ({ marginTop: 12, opacity: pressed ? 0.6 : 1 })}
            >
              <Text style={[typography.bodyMedium, { color: theme.colors.accent }]}>Retry</Text>
            </Pressable>
          </View>
        ) : visibleModels.length === 0 ? (
          <View style={styles.centerState}>
            <AppIcon name="search" size={24} color={theme.colors.textMuted} />
            <Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 9 }]}>No matching models</Text>
          </View>
        ) : (
          visibleModels.map((entry) => {
            const selected = isCurrent(entry);
            return (
              <Pressable
                key={`${entry.provider}/${entry.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Use ${modelName(entry)}`}
                accessibilityState={{ selected }}
                onPress={() => onSelect({ provider: entry.provider, id: entry.id, name: modelName(entry) })}
                android_ripple={{ color: theme.colors.pressOverlay }}
                style={({ pressed }) => ({
                  minHeight: 66,
                  paddingHorizontal: 10,
                  borderRadius: 12,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 11,
                  backgroundColor: pressed
                    ? theme.colors.surfacePressed
                    : selected
                      ? theme.colors.accentSoft
                      : "transparent",
                  borderWidth: selected ? 1 : 0,
                  borderColor: theme.colors.accentBorder,
                })}
              >
                <View style={[styles.modelIcon, { backgroundColor: selected ? theme.colors.accentSoft : theme.colors.surfaceRaised }]}>
                  <AppIcon name="sparkles" size={18} color={selected ? theme.colors.accent : theme.colors.textMuted} />
                </View>
                <View style={styles.modelText}>
                  <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>{modelName(entry)}</Text>
                  <Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>{modelDescription(entry)}</Text>
                </View>
                {selected ? <AppIcon name="check" size={18} color={theme.colors.accent} /> : null}
              </Pressable>
            );
          })
        )}
      </View>
    </AdaptiveSheet>
  );
}

const styles = {
  modelIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  modelText: {
    flex: 1,
    minWidth: 0,
  },
  centerState: {
    minHeight: 150,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    paddingHorizontal: 18,
  },
} satisfies Record<string, object>;
