import { ModelIcon, modelMappings } from "@lobehub/icons-rn";
import type { ModelCatalogEntry, ModelStatusEntry } from "@neta-art/cohub";
import { useMemo, useState, type RefObject } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ComposerMenu } from "@/src/components/ComposerMenu";
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
import { useTranslation } from "@/src/i18n";
import { AppIcon, IconButton } from "@/src/ui";

export type ModelSelectorMenuProps = {
  anchorRef: RefObject<View | null>;
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
  return <View accessibilityLabel={`${modelDisplayName(entry)} status: ${modelAvailabilityLabel(level)}`} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />;
}

function modelIconModel(entry: ModelCatalogEntry) {
  const id = modelIconLookupId(entry.id);
  const prefixed = `${entry.provider}/${id}`;
  const matches = (value: string) => modelMappings.some((item) => item.keywords.some((keyword) => new RegExp(keyword, "i").test(value)));
  if (matches(id)) return id;
  return matches(prefixed) ? prefixed : null;
}

// LobeHub treats any "gpt-5" substring as the GPT-5 pink avatar. GPT-5.6+ should use the generic ChatGPT mark, same as gpt-6.
function modelIconLookupId(id: string) {
  return /gpt-5\.(?:[6-9]|\d{2,})/i.test(id) ? "openai" : id;
}

function ModelBrandMark({ entry }: { entry: ModelCatalogEntry }) {
  const theme = useAppTheme();
  const model = modelIconModel(entry);
  return model ? <ModelIcon model={model} type="avatar" size={23} shape="square" /> : <AppIcon name={modelSupportsVision(entry) ? "images" : "sparkles"} size={17} color={theme.colors.textMuted} />;
}

function makeSelection(entry: ModelCatalogEntry, level?: ChatModelSelection["thinkingLevel"]): ChatModelSelection {
  return { provider: entry.provider, id: entry.id, name: modelDisplayName(entry), ...(level ? { thinkingLevel: level } : {}) };
}

export function ModelSelectorMenu({ anchorRef, models, loading, error, modelStatus = null, modelStatusLoading = false, currentModel, onClose, onRetry, onSelect }: ModelSelectorMenuProps) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [optionsOpenFor, setOptionsOpenFor] = useState<string | null>(null);

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
    setOptionsOpenFor(null);
  };

  const renderModel = ({ item: entry }: { item: ModelCatalogEntry }) => {
    const selected = isCurrent(entry);
    const key = `${entry.provider}/${entry.id}`;
    const levels = getSupportedThinkingLevels(entry);
    const selectedLevel = selected && currentModel?.thinkingLevel ? clampThinkingLevel(entry, currentModel.thinkingLevel) : getDefaultThinkingLevel(entry);
    const optionsOpen = optionsOpenFor === key;
    const context = modelContextLabel(entry);
    const cost = modelCostLabel(entry);
    const summary = [entry.provider, context].filter(Boolean).join(" · ");
    return <View style={[styles.modelRow, { backgroundColor: selected ? theme.colors.surfaceRaised : "transparent" }]}>
      <View style={styles.modelMainRow}>
        <Pressable testID={`model-option-${entry.provider}-${entry.id}`} accessibilityRole="radio" accessibilityLabel={t("model.use", { name: modelDisplayName(entry) })} accessibilityState={{ checked: selected }} onPress={() => selectEntry(entry, levels.length > 1 ? selectedLevel : undefined)} style={({ pressed }) => [styles.modelSelect, { backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" }]}>
          <View style={styles.modelIcon}><ModelBrandMark entry={entry} /></View>
          <View style={styles.modelText}>
            <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>{modelDisplayName(entry)}</Text>
            <View style={styles.modelSummary}><ModelStatusDot entry={entry} status={modelStatus?.[entry.id] ?? null} /><Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted, flex: 1 }]}>{summary}</Text></View>
          </View>
          <View style={styles.selectionMark}>{selected ? <AppIcon name="check" size={18} color={theme.colors.text} /> : null}</View>
        </Pressable>
        <Pressable testID={`model-settings-${entry.provider}-${entry.id}`} accessibilityRole="button" accessibilityLabel={t("model.options", { name: modelDisplayName(entry) })} accessibilityState={{ expanded: optionsOpen }} onPress={() => setOptionsOpenFor(optionsOpen ? null : key)} style={({ pressed }) => [styles.optionsTrigger, { backgroundColor: pressed || optionsOpen ? theme.colors.surfacePressed : "transparent" }]}>
          <AppIcon name="settings" size={18} color={optionsOpen ? theme.colors.accent : theme.colors.textMuted} />
        </Pressable>
      </View>
      {optionsOpen ? <View testID={`model-details-${entry.provider}-${entry.id}`} style={[styles.modelDetails, { borderTopColor: theme.colors.border }]}>
        <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{modelDisplayName(entry)}</Text>
        <Text selectable style={[typography.caption, { color: theme.colors.textMuted }]}>{entry.provider} · {entry.id}</Text>
        {context ? <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{context}</Text> : null}
        {cost ? <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{cost}</Text> : null}
        {levels.length > 1 ? <>
          <Text style={[typography.caption, { color: theme.colors.textSecondary, marginTop: 4 }]}>{t("model.thinking", { level: formatThinkingLevel(selectedLevel) })}</Text>
          <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>{levels.map((level) => { const active = level === selectedLevel; return <Pressable key={level} accessibilityRole="radio" accessibilityLabel={t("model.useThinking", { level: formatThinkingLevel(level) })} accessibilityState={{ checked: active }} onPress={() => selectEntry(entry, level)} style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 12, borderRadius: 8, justifyContent: "center", backgroundColor: pressed ? theme.colors.surfacePressed : active ? theme.colors.accentSoft : "transparent" })}><Text style={[typography.caption, { color: active ? theme.colors.accent : theme.colors.textMuted }]}>{formatThinkingLevelShort(level)}</Text></Pressable>; })}</ScrollView>
        </> : null}
      </View> : null}
    </View>;
  };

  return <ComposerMenu anchorRef={anchorRef} title={t("model.title")} onClose={onClose} preferredWidth={360} fillHeight testID="chat-model-selector-menu">
    <View style={[styles.searchRow, { borderBottomColor: theme.colors.border }]}>
      <AppIcon name="search" size={18} color={theme.colors.textMuted} />
      <TextInput accessibilityLabel={t("model.search")} value={query} onChangeText={setQuery} placeholder={t("model.search")} placeholderTextColor={theme.colors.textFaint} style={[typography.body, { flex: 1, minWidth: 0, color: theme.colors.text, paddingVertical: 8 }]} returnKeyType="search" autoCorrect={false} autoCapitalize="none" />
      {loading || modelStatusLoading ? <ActivityIndicator size="small" color={theme.colors.textMuted} /> : null}
      {query ? <IconButton name="circle-x" label={t("ui.search.clear")} size={36} onPress={() => setQuery("")} /> : <IconButton name="x" label={t("ui.sheet.close", { title: t("model.title") })} size={36} onPress={onClose} />}
    </View>
    <FlatList
      data={visibleModels}
      keyExtractor={(entry) => `${entry.provider}/${entry.id}`}
      renderItem={renderModel}
      style={{ flex: 1, minHeight: 0 }}
      contentContainerStyle={{ padding: 6 }}
      nestedScrollEnabled
      keyboardShouldPersistTaps="always"
      removeClippedSubviews={false}
      ListHeaderComponent={<>
        <Pressable testID="model-option-automatic" accessibilityRole="radio" accessibilityLabel={t("model.automaticA11y")} accessibilityState={{ checked: currentModel === null }} onPress={() => { onSelect(null); setOptionsOpenFor(null); }} style={({ pressed }) => [styles.automaticRow, { backgroundColor: pressed ? theme.colors.surfacePressed : currentModel === null ? theme.colors.surfaceRaised : "transparent" }]}>
          <View style={styles.modelIcon}><AppIcon name="sparkles" size={22} color={theme.colors.textSecondary} /></View>
          <View style={styles.modelText}><Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{t("model.automatic")}</Text><Text numberOfLines={1} style={[typography.caption, { color: theme.colors.textMuted }]}>{t("model.automaticDetail")}</Text></View>
          <View style={styles.selectionMark}>{currentModel === null ? <AppIcon name="check" size={18} color={theme.colors.text} /> : null}</View>
        </Pressable>
        {error ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 10 }}><Text style={[typography.caption, { color: theme.colors.danger, flex: 1 }]}>{error}</Text><IconButton name="refresh" label={t("model.retry")} onPress={onRetry} disabled={loading || modelStatusLoading} /></View> : null}
      </>}
      ListEmptyComponent={error && !loading ? null : <View style={styles.centerState}>
        {loading ? <ActivityIndicator size="small" color={theme.colors.textMuted} /> : <AppIcon name="search" size={22} color={theme.colors.textMuted} />}
        <Text style={[typography.caption, { color: theme.colors.textMuted, textAlign: "center", marginTop: 8 }]}>{t(loading ? "model.loading" : "model.noMatch")}</Text>
      </View>}
    />
  </ComposerMenu>;
}

const styles = {
  searchRow: { minHeight: 52, flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingLeft: 16, paddingRight: 6, borderBottomWidth: 1 },
  automaticRow: { minHeight: 56, marginBottom: 2, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
  modelRow: { marginBottom: 2, borderRadius: 8 },
  modelMainRow: { flexDirection: "row" as const, alignItems: "center" as const },
  modelSelect: { flex: 1, minWidth: 0, minHeight: 56, paddingLeft: 10, paddingRight: 4, paddingVertical: 8, borderRadius: 8, flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
  modelIcon: { width: 28, height: 28, alignItems: "center" as const, justifyContent: "center" as const },
  modelText: { flex: 1, minWidth: 0 },
  modelSummary: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5 },
  selectionMark: { width: 20, height: 20, alignItems: "center" as const, justifyContent: "center" as const },
  optionsTrigger: { width: 44, height: 44, borderRadius: 8, alignItems: "center" as const, justifyContent: "center" as const },
  modelDetails: { borderTopWidth: 1, marginHorizontal: 10, paddingVertical: 10, gap: 4 },
  centerState: { minHeight: 100, alignItems: "center" as const, justifyContent: "center" as const, padding: 16 },
} satisfies Record<string, object>;
