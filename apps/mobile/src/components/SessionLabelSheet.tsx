import type { CohubClient, LabelAssignmentRecord } from "@neta-art/cohub";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import {
  attachSessionLabel,
  createSessionLabel,
  detachSessionLabel,
  fetchSessionLabelAssignments,
  fetchSessionLabels,
  formatLabelRef,
  toUserSessionLabels,
  type SessionLabel,
} from "@/src/data/session-labels";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon } from "@/src/ui";

type SessionLabelSheetProps = {
  client: CohubClient;
  spaceId: string;
  session: { id: string; title?: string | null };
  labels?: SessionLabel[];
  labelsError?: string | null;
  onLabelsReload?: () => void;
  onClose: () => void;
  onChanged: () => void;
};

export function SessionLabelSheet({ client, spaceId, session, labels = [], labelsError = null, onLabelsReload, onClose, onChanged }: SessionLabelSheetProps) {
  const theme = useAppTheme();
  const [fetchedCatalog, setFetchedCatalog] = useState<SessionLabel[]>([]);
  const [assignments, setAssignments] = useState<LabelAssignmentRecord[]>([]);
  const [loading, setLoading] = useState(labels.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [busyLabelIds, setBusyLabelIds] = useState<Set<string>>(new Set());
  const [newLabelName, setNewLabelName] = useState("");
  const [creating, setCreating] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const catalog = fetchedCatalog.length > 0 ? fetchedCatalog : labels;

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) {
        setLoading(true);
        setError(null);
      }
    });
    void Promise.all([
      fetchSessionLabels(client, spaceId),
      fetchSessionLabelAssignments(client, spaceId, session.id),
    ])
      .then(([tree, assigned]) => {
        if (!active) return;
        setFetchedCatalog(toUserSessionLabels(tree));
        setAssignments(assigned);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "Unable to load labels");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, reloadToken, session.id, spaceId]);

  const assignedIds = useMemo(() => new Set(assignments.map((item) => item.labelId)), [assignments]);
  const selectable = useMemo(() => catalog.filter((label) => !label.system), [catalog]);

  const reload = useCallback(() => {
    setReloadToken((value) => value + 1);
    onLabelsReload?.();
  }, [onLabelsReload]);

  const toggle = useCallback(async (label: SessionLabel) => {
    if (busyLabelIds.has(label.id) || label.system) return;
    const ref = formatLabelRef(label);
    if (!ref) return;
    const wasAssigned = assignedIds.has(label.id);
    setBusyLabelIds((current) => new Set([...current, label.id]));
    setError(null);
    setAssignments((current) => wasAssigned
      ? current.filter((item) => item.labelId !== label.id)
      : [...current, { labelId: label.id, labelName: label.name, labelSystemKey: label.systemKey } as LabelAssignmentRecord]);
    try {
      if (wasAssigned) await detachSessionLabel(client, spaceId, ref, session.id);
      else await attachSessionLabel(client, spaceId, ref, session.id);
      onChanged();
    } catch (caught) {
      setAssignments((current) => wasAssigned
        ? [...current, { labelId: label.id, labelName: label.name, labelSystemKey: label.systemKey } as LabelAssignmentRecord]
        : current.filter((item) => item.labelId !== label.id));
      setError(caught instanceof Error ? caught.message : "Unable to update labels");
    } finally {
      setBusyLabelIds((current) => {
        const next = new Set(current);
        next.delete(label.id);
        return next;
      });
    }
  }, [assignedIds, busyLabelIds, client, onChanged, session.id, spaceId]);

  const create = useCallback(async () => {
    const name = newLabelName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createSessionLabel(client, spaceId, name);
      setNewLabelName("");
      const tree = await fetchSessionLabels(client, spaceId);
      const nextCatalog = toUserSessionLabels(tree);
      setFetchedCatalog(nextCatalog);
      onLabelsReload?.();
      const createdLabel = created ? nextCatalog.find((item) => item.id === created.id) ?? created : null;
      if (createdLabel) await toggle(createdLabel);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create label");
    } finally {
      setCreating(false);
    }
  }, [client, creating, newLabelName, onLabelsReload, spaceId, toggle]);

  return (
    <AdaptiveSheet
      visible
      title="Labels"
      subtitle="Choose a label for this Chat, or create a new one."
      onClose={onClose}
      testID="session-label-sheet"
      footer={
        <View>
          <Text style={[typography.caption, { color: theme.colors.textMuted, marginBottom: 8 }]}>Create label</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <TextInput
                value={newLabelName}
                onChangeText={setNewLabelName}
                placeholder="Label name"
                placeholderTextColor={theme.colors.textFaint}
                editable={!creating}
                onSubmitEditing={() => void create()}
                style={{ minHeight: 42, paddingHorizontal: 12, borderRadius: 11, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.background, color: theme.colors.text, fontSize: 15 }}
              />
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Create label" disabled={!newLabelName.trim() || creating} onPress={() => void create()} style={({ pressed }) => ({ minHeight: 42, paddingHorizontal: 14, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: !newLabelName.trim() || creating ? theme.colors.surfaceRaised : pressed ? theme.colors.accentPressed : theme.colors.accent, opacity: !newLabelName.trim() || creating ? 0.6 : 1 })}>
              {creating ? <ActivityIndicator size="small" color={theme.colors.accentText} /> : <Text style={[typography.bodyMedium, { color: theme.colors.accentText }]}>Create</Text>}
            </Pressable>
          </View>
        </View>
      }
    >
      {labelsError ? <Pressable accessibilityRole="button" accessibilityLabel="Retry loading labels" onPress={reload} style={{ paddingVertical: 8 }}><Text style={[typography.caption, { color: theme.colors.accent }]}>Labels failed to load — tap to retry</Text></Pressable> : null}
      {loading && selectable.length === 0 ? <View style={{ paddingVertical: 24, alignItems: "center" }}><ActivityIndicator size="small" color={theme.colors.accent} /></View> : selectable.length === 0 ? (
        <Text style={[typography.caption, { color: theme.colors.textMuted, paddingVertical: 14 }]}>No labels in this Space yet. Create one below, then tap it to add this Chat.</Text>
      ) : selectable.map((item) => {
        const assigned = assignedIds.has(item.id);
        const busy = busyLabelIds.has(item.id);
        return (
          <Pressable
            key={item.id}
            accessibilityRole="checkbox"
            accessibilityLabel={`Add to ${item.name}`}
            accessibilityState={{ checked: assigned }}
            onPress={() => void toggle(item)}
            disabled={busy}
            style={({ pressed }) => ({ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, borderRadius: 11, backgroundColor: pressed ? theme.colors.surfacePressed : assigned ? theme.colors.accentSoft : "transparent" })}
          >
            <View style={{ width: 24, height: 24, borderRadius: 8, borderWidth: 1.5, borderColor: assigned ? theme.colors.accent : theme.colors.borderStrong, backgroundColor: assigned ? theme.colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
              {assigned ? <AppIcon name="check" size={15} color={theme.colors.accentText} /> : null}
            </View>
            <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text, flex: 1 }]}>{item.name}</Text>
            {busy ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
          </Pressable>
        );
      })}
      {error ? <Text selectable style={[typography.micro, { color: theme.colors.danger, marginTop: 8 }]}>{error}</Text> : null}
    </AdaptiveSheet>
  );
}
