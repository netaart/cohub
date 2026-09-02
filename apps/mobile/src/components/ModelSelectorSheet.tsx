import type { ModelCatalogEntry, ModelStatusEntry } from "@neta-art/cohub";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import type { ChatModelSelection } from "@/src/data/types";
import {
  clampThinkingLevel,
  formatThinkingLevel,
  formatThinkingLevelShort,
  getDefaultThinkingLevel,
  getSupportedThinkingLevels,
  modelAvailabilityLabel,
  modelAvailabilityLevel,
  modelContextLabel,
  modelCostLabel,
  modelDisplayName,
  modelSupportsVision,
  type ModelAvailabilityLevel,
} from "@/src/model-catalog";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, SearchField } from "@/src/ui";

export type ModelSelectorSheetProps = {
  visible: boolean;
  models: ModelCatalogEntry[];
  loading: boolean;
  error: string | null;
  modelStatus?: Record<string, ModelStatusEntry> | null;
  modelStatusLoading?: boolean;
  currentModel: ChatModelSelection | null;
  onClose: () => void;
  onRetry: () => void;
  onSelect: (model: ChatModelSelection | null) => void;
};

function statusColor(level: ModelAvailabilityLevel, theme: ReturnType<typeof useAppTheme>) {
  switch (level) {
    case "available": return theme.colors.success;
    case "degraded": return theme.colors.warning;
    case "outage": return theme.colors.danger;
    case "unknown": return theme.colors.textFaint;
  }
}

function ModelStatusDot({ entry, status }: { entry: ModelCatalogEntry; status: ModelStatusEntry | null }) {
  const theme = useAppTheme();
  const level = modelAvailabilityLevel(status);
  const color = statusColor(level, theme);
  return <View accessibilityLabel={`${modelDisplayName(entry)} status: ${modelAvailabilityLabel(level)}`} style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color, shadowColor: color, shadowOpacity: level === "unknown" ? 0 : 0.45, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } }} />;
}

function makeSelection(entry: ModelCatalogEntry, level?: ChatModelSelection["thinkingLevel"]): ChatModelSelection {
  return { provider: entry.provider, id: entry.id, name: modelDisplayName(entry), ...(level ? { thinkingLevel: level } : {}) };
}

export function ModelSelectorSheet({ visible, models, loading, error, modelStatus = null, modelStatusLoading = false, currentModel, onClose, onRetry, onSelect }: ModelSelectorSheetProps) {
  const theme = useAppTheme();
  const [query, setQuery] = useState("");
  const [thinkingOpenFor, setThinkingOpenFor] = useState<string | null>(null);

  const visibleModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = models
      .filter((entry) => entry.model?.hidden !== true)
      .filter((entry) => !needle || [entry.provider, entry.id, modelDisplayName(entry)].some((value) => value.toLowerCase().includes(needle)));
    if (!needle && currentModel) {
      filtered.sort((left, right) => {
        const leftCurrent = left.provider === currentModel.provider && left.id === currentModel.id;
        const rightCurrent = right.provider === currentModel.provider && right.id === currentModel.id;
        if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
        return `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`);
      });
    }
    return filtered;
  }, [currentModel, models, query]);

  const isCurrent = (entry: ModelCatalogEntry) => currentModel?.provider === entry.provider && currentModel.id === entry.id;
  const selectEntry = (entry: ModelCatalogEntry, level?: ChatModelSelection["thinkingLevel"]) => {
    onSelect(makeSelection(entry, level));
    setThinkingOpenFor(null);
  };

  return <AdaptiveSheet visible={visible} title="Choose a model" subtitle="Select the model and thinking level for the next message." onClose={onClose} scrollable={false} contentStyle={{ flex: 1, minHeight: 0 }} testID="chat-model-selector-sheet">
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ flex: 1 }}><SearchField value={query} onChangeText={setQuery} placeholder="Search models" /></View>
      {modelStatusLoading ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="Use automatic model selection" accessibilityState={{ selected: currentModel === null }} onPress={() => { onSelect(null); setThinkingOpenFor(null); }} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => [styles.automaticRow, { backgroundColor: pressed ? theme.colors.surfacePressed : currentModel === null ? theme.colors.accentSoft : theme.colors.surfaceRaised, borderColor: currentModel === null ? theme.colors.accentBorder : theme.colors.border }]}>
      <View style={[styles.modelIcon, { backgroundColor: theme.colors.background }]}><AppIcon name="sparkles" size={18} color={theme.colors.accent} /></View>
      <View style={styles.modelText}><Text style={[typography.bodyMedium, { color: theme.colors.text }]}>Automatic</Text><Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, marginTop: 2 }]}>Let Cohub route to an available model</Text></View>
      {currentModel === null ? <AppIcon name="check" size={18} color={theme.colors.accent} /> : <AppIcon name="chevron-right" size={17} color={theme.colors.textFaint} />}
    </Pressable>
    {loading && visibleModels.length === 0 ? <View style={styles.centerState}><ActivityIndicator size="small" color={theme.colors.accent} /><Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 9 }]}>Loading models</Text></View> : error && visibleModels.length === 0 ? <View style={styles.centerState}><AppIcon name="cloud-off" size={24} color={theme.colors.danger} /><Text style={[typography.body, { color: theme.colors.danger, textAlign: "center", marginTop: 9 }]}>{error}</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry loading models" onPress={onRetry} style={({ pressed }) => ({ marginTop: 12, opacity: pressed ? 0.6 : 1 })}><Text style={[typography.bodyMedium, { color: theme.colors.accent }]}>Retry</Text></Pressable></View> : visibleModels.length === 0 ? <View style={styles.centerState}><AppIcon name="search" size={24} color={theme.colors.textMuted} /><Text style={[typography.body, { color: theme.colors.textMuted, marginTop: 9 }]}>No matching models</Text></View> : <ScrollView style={{ flex: 1, minHeight: 0, marginTop: 10 }} contentContainerStyle={{ paddingBottom: 14 }} nestedScrollEnabled keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      {visibleModels.map((entry) => {
        const selected = isCurrent(entry);
        const key = `${entry.provider}/${entry.id}`;
        const levels = getSupportedThinkingLevels(entry);
        const selectedLevel = selected && currentModel?.thinkingLevel ? clampThinkingLevel(entry, currentModel.thinkingLevel) : getDefaultThinkingLevel(entry);
        const thinkingOpen = thinkingOpenFor === key;
        const context = modelContextLabel(entry);
        const cost = modelCostLabel(entry);
        return <View key={key} style={[styles.modelRow, { backgroundColor: selected ? theme.colors.accentSoft : "transparent", borderColor: selected ? theme.colors.accentBorder : theme.colors.border }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Use ${modelDisplayName(entry)}`} accessibilityState={{ selected }} onPress={() => selectEntry(entry, levels.length > 1 ? selectedLevel : undefined)} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ flexDirection: "row", alignItems: "flex-start", gap: 10, opacity: pressed ? 0.72 : 1 })}>
            <View style={[styles.modelIcon, { backgroundColor: selected ? theme.colors.background : theme.colors.surfaceRaised }]}><AppIcon name={modelSupportsVision(entry) ? "images" : "sparkles"} size={17} color={selected ? theme.colors.accent : theme.colors.textMuted} /></View>
            <View style={styles.modelText}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}><Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, flex: 1 }]}>{modelDisplayName(entry)}</Text><ModelStatusDot entry={entry} status={modelStatus?.[entry.id] ?? null} /></View>
              <Text numberOfLines={1} style={[typography.micro, { color: theme.colors.textMuted, marginTop: 3 }]}>{entry.provider} · {entry.id}</Text>
              {context || cost ? <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginTop: 4 }}>{context ? <Text style={[typography.micro, { color: theme.colors.textFaint }]}>{context}</Text> : null}{cost ? <Text numberOfLines={1} style={[typography.micro, { color: theme.colors.textFaint, flexShrink: 1 }]}>{cost}</Text> : null}</View> : null}
            </View>
            {selected ? <AppIcon name="check" size={17} color={theme.colors.accent} /> : <AppIcon name="chevron-right" size={16} color={theme.colors.textFaint} />}
          </Pressable>
          {levels.length > 1 ? <View style={{ marginTop: 8, paddingLeft: 46 }}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Thinking level ${formatThinkingLevel(selectedLevel)}`} accessibilityState={{ expanded: thinkingOpen }} onPress={() => setThinkingOpenFor(thinkingOpen ? null : key)} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => [styles.thinkingTrigger, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.background, borderColor: thinkingOpen ? theme.colors.accentBorder : theme.colors.border }]}>
              <AppIcon name="brain" size={14} color={theme.colors.accent} /><Text style={[typography.micro, { color: theme.colors.textSecondary, flex: 1 }]}>Thinking · {formatThinkingLevel(selectedLevel)}</Text><AppIcon name="chevron-down" size={13} color={theme.colors.textMuted} style={{ transform: [{ rotate: thinkingOpen ? "180deg" : "0deg" }] }} />
            </Pressable>
            {thinkingOpen ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingTop: 7, paddingBottom: 2 }}>{levels.map((level) => { const active = level === selectedLevel; return <Pressable key={level} accessibilityRole="button" accessibilityLabel={`Use ${formatThinkingLevel(level)} thinking`} accessibilityState={{ selected: active }} onPress={() => selectEntry(entry, level)} android_ripple={{ color: theme.colors.pressOverlay }} style={({ pressed }) => ({ minHeight: 32, paddingHorizontal: 10, borderRadius: 8, justifyContent: "center", borderWidth: 1, borderColor: active ? theme.colors.accentBorder : theme.colors.border, backgroundColor: active ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface })}><Text style={[typography.micro, { color: active ? theme.colors.accent : theme.colors.textMuted }]}>{formatThinkingLevelShort(level)}</Text></Pressable>; })}</ScrollView> : null}
          </View> : null}
        </View>;
      })}
    </ScrollView>}
  </AdaptiveSheet>;
}

const styles = {
  automaticRow: { minHeight: 64, marginTop: 12, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 12, borderWidth: 1, flexDirection: "row" as const, alignItems: "center" as const, gap: 11 },
  modelRow: { minHeight: 76, marginBottom: 5, paddingHorizontal: 10, paddingVertical: 10, borderRadius: 12, borderWidth: 1 },
  modelIcon: { width: 35, height: 35, borderRadius: 11, alignItems: "center" as const, justifyContent: "center" as const },
  modelText: { flex: 1, minWidth: 0 },
  thinkingTrigger: { minHeight: 30, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1, flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
  centerState: { minHeight: 180, alignItems: "center" as const, justifyContent: "center" as const, paddingHorizontal: 18 },
} satisfies Record<string, object>;
