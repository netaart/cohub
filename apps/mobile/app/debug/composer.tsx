import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  getComposerActionState,
  type ComposerActionStateInput,
} from "@/src/data/composer-state";
import { AttachmentMenu } from "@/src/components/AttachmentMenu";
import { ModelSelectorMenu } from "@/src/components/ModelSelectorMenu";
import { useApp } from "@/src/data/context";
import type { ChatModelSelection } from "@/src/data/types";
import { formatThinkingLevel, modelAvailabilityLevel } from "@/src/model-catalog";
import { typography, useAppTheme } from "@/src/theme";
import { ComposerInput, Screen, SectionHeader } from "@/src/ui";

function buildMatrix() {
  const rows: ComposerActionStateInput[] = [];
  for (const text of ["", "hi"]) {
    for (const hasAttachment of [false, true]) {
      for (const disabled of [false, true]) {
        for (const sending of [false, true]) {
          for (const running of [false, true]) {
            for (const hasStopHandler of [false, true]) {
              rows.push({ text, hasAttachment, disabled, sending, running, hasStopHandler });
            }
          }
        }
      }
    }
  }
  return rows;
}

export default function DebugComposerScreen() {
  const theme = useAppTheme();
  const matrix = useMemo(() => buildMatrix(), []);
  const { models, modelsLoading, modelsError, modelStatus, modelStatusLoading, modelStatusError, loadModels, loadModelStatus } = useApp();
  const composerRef = useRef<View>(null);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ChatModelSelection | null>(null);
  const [text, setText] = useState("");
  const [attach, setAttach] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [sending, setSending] = useState(false);
  const [running, setRunning] = useState(false);
  const [hasStop, setHasStop] = useState(true);
  const modelLabel = selectedModel?.name ?? selectedModel?.id;
  const modelTriggerLabel = selectedModel?.thinkingLevel ? `${modelLabel} · ${formatThinkingLevel(selectedModel.thinkingLevel)}` : modelLabel;
  const live = getComposerActionState({ text, hasAttachment: attach, disabled, sending, running, hasStopHandler: hasStop });

  return (
    <Screen keyboard>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <SectionHeader title="交互预览" />
        <View style={{ paddingHorizontal: 16, paddingBottom: 6, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Toggle label="附件" on={attach} onPress={() => setAttach((v) => !v)} />
          <Toggle label="disabled" on={disabled} onPress={() => setDisabled((v) => !v)} />
          <Toggle label="sending" on={sending} onPress={() => setSending((v) => !v)} />
          <Toggle label="running" on={running} onPress={() => setRunning((v) => !v)} />
          <Toggle label="onStop" on={hasStop} onPress={() => setHasStop((v) => !v)} />
        </View>
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <Text selectable style={[typography.code, { color: theme.colors.textSecondary }]}>
            {`blocked=${live.blocked}  hasDraft=${live.hasDraft}  canSend=${live.canSend}  canStop=${live.canStop}`}
          </Text>
        </View>
        <View style={{ paddingHorizontal: 16, paddingBottom: 8, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Toggle label="单行" on={text === "Hello"} onPress={() => setText("Hello")} />
          <Toggle label="多行" on={text === "First line\nSecond line\nThird line"} onPress={() => setText("First line\nSecond line\nThird line")} />
          <Toggle label="自动折行" on={text.startsWith("A long draft")} onPress={() => setText("A long draft that wraps across the input width. ".repeat(60))} />
          <Toggle label="清空" on={!text} onPress={() => setText("")} />
        </View>
        <SectionHeader title="状态矩阵（64 种组合）" />
        <Text style={[typography.caption, { color: theme.colors.textMuted, marginHorizontal: 16, marginBottom: 8 }]}>
          列：文本 / A 附件 / D disabled / S sending / R running / H onStop → 结果：B blocked / S canSend / T canStop
        </Text>
        <View style={[styles.table, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          <View style={[styles.headerRow, { borderBottomColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised }]}>
            {["文本", "A", "D", "S", "R", "H", "B", "S", "T"].map((cell) => (
              <Text key={cell} style={[typography.micro, styles.cell, { color: theme.colors.textMuted }]}>{cell}</Text>
            ))}
          </View>
          {matrix.map((row, index) => {
            const result = getComposerActionState(row);
            return (
              <View key={index} style={[styles.row, { borderBottomColor: theme.colors.border, backgroundColor: index % 2 === 0 ? "transparent" : theme.colors.surfaceRaised }]}>
                <Text style={[typography.micro, styles.cell, { color: row.text ? theme.colors.text : theme.colors.textFaint, fontFamily: "SpaceMono" }]}>{row.text || "·"}</Text>
                <Flag on={row.hasAttachment} theme={theme} />
                <Flag on={row.disabled} theme={theme} />
                <Flag on={row.sending} theme={theme} />
                <Flag on={row.running} theme={theme} />
                <Flag on={row.hasStopHandler} theme={theme} />
                <Result on={result.blocked} color={theme.colors.danger} theme={theme} />
                <Result on={result.canSend} color={theme.colors.success} theme={theme} />
                <Result on={result.canStop} color={theme.colors.warning} theme={theme} />
              </View>
            );
          })}
        </View>
      </ScrollView>
      <ComposerInput
        anchorRef={composerRef}
        attachmentMenuOpen={attachmentOpen}
        modelMenuOpen={modelOpen}
        value={text}
        onChangeText={setText}
        onSend={() => { setText(""); setAttach(false); }}
        onStop={hasStop ? () => setRunning(false) : undefined}
        onAttach={() => setAttachmentOpen(true)}
        onVoice={() => setVoiceActive((value) => !value)}
        voiceActive={voiceActive}
        onModelPress={() => { setModelOpen(true); void Promise.all([loadModels(), loadModelStatus()]).catch(() => undefined); }}
        modelLabel={modelTriggerLabel}
        modelStatus={selectedModel ? modelAvailabilityLevel(modelStatus?.models[selectedModel.id]) : "unknown"}
        sending={sending}
        running={running}
        disabled={disabled}
        hasAttachment={attach}
      />
      {attachmentOpen ? <AttachmentMenu anchorRef={composerRef} onClose={() => setAttachmentOpen(false)} onCamera={() => { setAttach(true); setAttachmentOpen(false); }} onPhotos={() => { setAttach(true); setAttachmentOpen(false); }} onFile={() => { setAttach(true); setAttachmentOpen(false); }} /> : null}
      {modelOpen ? <ModelSelectorMenu anchorRef={composerRef} models={models} loading={modelsLoading} error={modelsError || modelStatusError} modelStatus={modelStatus?.models ?? null} modelStatusLoading={modelStatusLoading} currentModel={selectedModel} onClose={() => setModelOpen(false)} onRetry={() => void Promise.all([loadModels({ force: true }), loadModelStatus({ force: true })]).catch(() => undefined)} onSelect={(model) => { setSelectedModel(model); setModelOpen(false); }} /> : null}
    </Screen>
  );
}

function Toggle({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: on }} accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ minHeight: 32, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: on ? theme.colors.accentBorder : theme.colors.border, backgroundColor: on ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface, justifyContent: "center" })}>
      <Text style={[typography.caption, { color: on ? theme.colors.accent : theme.colors.textMuted }]}>{label}</Text>
    </Pressable>
  );
}

function Flag({ on, theme }: { on: boolean; theme: ReturnType<typeof useAppTheme> }) {
  return <Text style={[typography.micro, styles.cell, { color: on ? theme.colors.text : theme.colors.textFaint, fontFamily: "SpaceMono" }]}>{on ? "1" : "0"}</Text>;
}

function Result({ on, color, theme }: { on: boolean; color: string; theme: ReturnType<typeof useAppTheme> }) {
  return <Text style={[typography.micro, styles.cell, { color: on ? color : theme.colors.textFaint, fontFamily: "SpaceMono", fontWeight: on ? "700" : "400" }]}>{on ? "1" : "0"}</Text>;
}

const styles = {
  table: { marginHorizontal: 16, borderWidth: 1, borderRadius: 12, overflow: "hidden" as const },
  headerRow: { flexDirection: "row" as const, alignItems: "center" as const, borderBottomWidth: 1, paddingVertical: 6 },
  row: { flexDirection: "row" as const, alignItems: "center" as const, borderBottomWidth: 1, paddingVertical: 5 },
  cell: { flex: 1, textAlign: "center" as const },
} satisfies Record<string, object>;
