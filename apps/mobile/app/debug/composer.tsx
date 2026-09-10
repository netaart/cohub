import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  getComposerActionState,
  type ComposerActionStateInput,
} from "@/src/data/composer-state";
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

  const [text, setText] = useState("");
  const [attach, setAttach] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [sending, setSending] = useState(false);
  const [running, setRunning] = useState(false);
  const [hasStop, setHasStop] = useState(true);
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
        <ComposerInput
          value={text}
          onChangeText={setText}
          onSend={() => undefined}
          onStop={hasStop ? () => undefined : undefined}
          onAttach={() => setAttach((v) => !v)}
          sending={sending}
          running={running}
          disabled={disabled}
          hasAttachment={attach}
        />

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
