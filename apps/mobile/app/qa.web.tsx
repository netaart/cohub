import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { useApp } from "@/src/data/context";
import { useAppTheme, typography } from "@/src/theme";
import { DetailTopBar, Screen } from "@/src/ui";

export default function QaScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const { state } = useApp();
  return <Screen scroll><DetailTopBar title="UI state lab" subtitle="Mock data preview" onBack={() => router.back()} /><View style={{ padding: 16, gap: 10 }}><Text style={[typography.body, { color: theme.colors.textMuted }]}>Use these fixtures to exercise the main component states.</Text><QaButton label="Chats: mixed statuses and long rows" onPress={() => router.replace("/")} /><QaButton label="Spaces: pinned, empty, and long descriptions" onPress={() => router.replace("/spaces")} /><QaButton label="Activity: running, needs you, and completed" onPress={() => router.replace("/activity")} /><QaButton label="Running chat and composer" onPress={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: "s-running" } })} /><QaButton label="Needs-attention chat" onPress={() => router.push({ pathname: "/chat/[sessionId]", params: { sessionId: "s-attention" } })} /><Text style={[typography.caption, { color: theme.colors.textFaint, marginTop: 8 }]}>{state.spaces.length} Spaces · {state.sessions.length} Chats · web preview fixtures</Text></View></Screen>;
}
function QaButton({ label, onPress }: { label: string; onPress: () => void }) { const theme = useAppTheme(); return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface, justifyContent: "center", paddingHorizontal: 14 })}><Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{label}</Text></Pressable>; }
