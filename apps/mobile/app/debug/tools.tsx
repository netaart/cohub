import type { ContentBlock, MessageRecord } from "@neta-art/cohub";
import { useRouter } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { MessageBubble } from "@/src/components/MessageContent";
import { typography, useAppTheme } from "@/src/theme";
import { DetailTopBar, Screen } from "@/src/ui";

const NOW = new Date().toISOString();

const LONG_OUTPUT = [
  "> cohub-mobile@1.7.0 typecheck",
  "> tsc --noEmit --noUnusedLocals --noUnusedParameters",
  "",
  ...Array.from({ length: 24 }, (_, index) => `src/components/MessageContent.tsx(${60 + index},7): error TS2322: Type 'string' is not assignable to type 'ReactNode'.`),
  "",
  "Found 24 errors in 1 file.",
].join("\n");

const FILE_OUTPUT = Array.from({ length: 36 }, (_, index) => `${String(index + 1).padStart(3, " ")}  ${index % 6 === 0 ? "// section" : "const value = compute(index);"}`).join("\n");

const EDIT_OLD = Array.from({ length: 12 }, (_, index) => `const oldLine${index} = "before";`).join("\n");
const EDIT_NEW = Array.from({ length: 12 }, (_, index) => `const newLine${index} = "after";`).join("\n");

const BLOCKS: ContentBlock[] = [
  { type: "text", text: "下面覆盖长输出、报错、编辑 diff 和运行中的工具调用。点每一行展开，重点看展开后下方的空白高度。" },
  { type: "tool_use", id: "t-short", name: "terminal", input: { command: "git status --short" } },
  { type: "tool_result", tool_use_id: "t-short", content: "## main", is_error: false },
  { type: "tool_use", id: "t-long", name: "terminal", input: { command: "npm run typecheck" } },
  { type: "tool_result", tool_use_id: "t-long", content: LONG_OUTPUT, is_error: false },
  { type: "tool_use", id: "t-read", name: "read_file", input: { path: "src/components/MessageContent.tsx" } },
  { type: "tool_result", tool_use_id: "t-read", content: FILE_OUTPUT, is_error: false },
  { type: "tool_use", id: "t-error", name: "terminal", input: { command: "npm run native:ios" } },
  { type: "tool_result", tool_use_id: "t-error", content: "xcrun: error: unable to find utility \"xcodebuild\"", is_error: true },
  { type: "tool_use", id: "t-edit", name: "edit", input: { path: "src/data/markdown.ts", edits: [{ oldText: EDIT_OLD, newText: EDIT_NEW }] } },
  { type: "tool_result", tool_use_id: "t-edit", content: "Applied 1 edit.", is_error: false },
  { type: "tool_use", id: "t-running", name: "read_file", input: { path: "src/data/markdown.ts" } },
  { type: "text", text: "如果展开后出现明显空白，记下是哪一种工具和大概高度，反馈给我。" },
];

const MESSAGE = {
  id: "debug-tools",
  sessionId: "debug-tools",
  role: "assistant",
  content: BLOCKS,
  text: "",
  sequence: 1,
  provider: "cohub",
  model: "debug-agent",
  stopReason: "stop",
  errorMessage: null,
  usage: null,
  meta: null,
  startedAt: NOW,
  completedAt: NOW,
  durationMs: 0,
  createdAt: NOW,
} as MessageRecord;

export default function DebugToolsScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  return (
    <Screen>
      <DetailTopBar title="工具展开验收" subtitle="长输出 / 报错 / 编辑 diff" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingVertical: 12 }} keyboardShouldPersistTaps="handled">
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <Text style={[typography.caption, { color: theme.colors.textMuted }]}>
            点击工具行展开或收起；展开态内部输出可纵向滚动。
          </Text>
        </View>
        <MessageBubble message={MESSAGE} />
      </ScrollView>
    </Screen>
  );
}
