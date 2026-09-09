import type { MessageRecord } from "@neta-art/cohub";
import { ScrollView, Text, View } from "react-native";
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
        </View>
        <MessageBubble message={MESSAGE} />
      </ScrollView>
    </Screen>
  );
}
