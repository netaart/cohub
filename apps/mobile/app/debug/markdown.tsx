import type { MessageRecord } from "@neta-art/cohub";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";
import { FlatList, ScrollView, Text, View } from "react-native";
import { MessageBubble } from "@/src/components/MessageContent";
import { typography, useAppTheme } from "@/src/theme";
import { Screen } from "@/src/ui";

const NOW = new Date().toISOString();

const MARKDOWN = `# 一级标题

普通段落，包含 **加粗**、*斜体*、\`行内代码\` 和 [链接](https://example.com)，以及一个很长的不可断开单词 supercalifragilisticexpialidociousssssssssssssssssssssssssssssss 用来测试换行。

## 二级标题

- 无序列表第一项
- 第二项带 \`code\`
- 第三项

1. 有序列表第一项
2. 第二项

> 引用内容，测试左侧竖线和颜色。

\`\`\`ts
type Result = { ok: true } | { ok: false; error: string };
export function unwrap(result: Result) {
  return result.ok ? result : result.error;
}
\`\`\`

\`\`\`python
def greet(name: str) -> str:
    return f"hello {name}"
\`\`\`

| 文件 | 错误数 | 状态 |
| --- | :---: | ---: |
| src/data/markdown.ts | 0 | 通过 |
| src/components/MessageContent.tsx | 2 | 待修 |
| src/components/CodeBlock.tsx | 0 | 通过 |

### 三级标题

结束段落。`;

const RAW_MARKDOWN = `裸组件对照：长按这段应当能选中文字（原生选择句柄 + 系统菜单）。

普通段落，包含 **加粗** 和 \`行内代码\`。`;

const MESSAGE = {
  id: "debug-markdown",
  sessionId: "debug-markdown",
  role: "assistant",
  content: [{ type: "text", text: MARKDOWN }],
  text: MARKDOWN,
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

export default function DebugMarkdownScreen() {
  const theme = useAppTheme();
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingVertical: 12 }} keyboardShouldPersistTaps="handled">
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <Text style={[typography.caption, { color: theme.colors.textMuted }]}>
            检查表格对齐、代码高亮、长单词换行和列表缩进。
          </Text>
          <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 6 }]}>
            长按选择排查：第一段是裸的原生 Markdown 组件，下面才是消息气泡。
          </Text>
        </View>
        <View style={{ paddingHorizontal: 16, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
          <EnrichedMarkdownText markdown={RAW_MARKDOWN} selectable flavor="github" />
        </View>
        <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
          <Text style={[typography.caption, { color: theme.colors.textMuted }]}>
            下面这个高度固定的反转列表复刻了 chat 的容器结构（inverted FlatList），用来区分「列表」和「翻页器」谁是罪魁。
          </Text>
        </View>
        <View style={{ height: 240, marginTop: 8 }}>
          <FlatList
            inverted
            data={[MESSAGE]}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <MessageBubble message={item} />}
            contentContainerStyle={{ paddingVertical: 8 }}
          />
        </View>
        <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
          <Text style={[typography.caption, { color: theme.colors.textMuted }]}>
            非反转列表（同高度同内容）：这个能选、上面反转列表不能选，就说明是 inverted 的 scaleY(-1) 变换导致的。
          </Text>
        </View>
        <View style={{ height: 240, marginTop: 8 }}>
          <FlatList
            data={[MESSAGE]}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <MessageBubble message={item} />}
            contentContainerStyle={{ paddingVertical: 8 }}
          />
        </View>
        <MessageBubble message={MESSAGE} />
      </ScrollView>
    </Screen>
  );
}
