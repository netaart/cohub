import type { ContentBlock, MessageRecord } from "@neta-art/cohub";

export type BubbleFixtureGroup = "Text" | "Rich" | "States";
export type BubbleFixture = {
  id: string;
  title: string;
  group: BubbleFixtureGroup;
  text?: string;
  content?: ContentBlock[];
  summary?: string | null;
  local?: boolean;
  error?: string;
  invalidClock?: boolean;
};

export function bubbleFixtures(imageUri: string): BubbleFixture[] {
  const image: ContentBlock = { type: "image", source: { type: "url", url: imageUri } };
  return [
    { id: "hello", title: "01 / Short reply", group: "Text", text: "你好" },
    { id: "request", title: "02 / Short request", group: "Text", text: "只回复我你好" },
    { id: "english", title: "03 / Latin text", group: "Text", text: "The change is ready." },
    { id: "wrap", title: "04 / Wrapping paragraph", group: "Text", text: "The message contains enough words to wrap naturally across several lines. The final line is short." },
    { id: "newline", title: "05 / Explicit line breaks", group: "Text", text: "第一行是比较长的一行文字，需要保持自然换行。\n第二行\n好" },
    { id: "paragraphs", title: "06 / Multiple paragraphs", group: "Text", text: "First paragraph.\n\nSecond paragraph with a longer sentence.\n\nDone." },
    { id: "emoji", title: "07 / Emoji and mixed scripts", group: "Text", text: "收到 👍🏽 ✅ café é 中文 English 12345" },
    { id: "rtl", title: "08 / RTL and mixed direction", group: "Text", text: "مرحبا بكم في المحادثة 123\nשלום עולם" },
    { id: "long-token", title: "09 / Unbroken token", group: "Text", text: "long_filename_".repeat(15) + ".tsx" },
    { id: "long", title: "10 / Multi-screen paragraph", group: "Text", text: Array.from({ length: 60 }, (_, index) => `Line ${index + 1}: This is a long message with a stable sequence of numbered lines.`).join("\n") },
    { id: "heading", title: "11 / Heading at end", group: "Rich", text: "Introductory paragraph.\n\n## Completed" },
    { id: "quote", title: "12 / Quote at end", group: "Rich", text: "> A quoted paragraph with several words and a short final line." },
    { id: "list", title: "13 / List at end", group: "Rich", text: "1. A longer first item with words that may wrap.\n2. Done" },
    { id: "inline", title: "14 / Inline formatting and link", group: "Rich", text: "**Bold text** with *emphasis*, `inline code`, and [a link](https://example.com)." },
    { id: "code", title: "15 / Code at end", group: "Rich", text: "```ts\nconst message = 'hello';\nconsole.log(message);\n```" },
    { id: "table", title: "16 / Table at end", group: "Rich", text: "| Name | State |\n| --- | --- |\n| Short | Ready |\n| Longer content | Pending |" },
    { id: "image", title: "17 / Image only", group: "Rich", content: [image] },
    { id: "image-text", title: "18 / Image then text", group: "Rich", content: [image, { type: "text", text: "Image received." }] },
    { id: "text-image", title: "19 / Text then gallery", group: "Rich", content: [{ type: "text", text: "Two images." }, image, image] },
    { id: "tool", title: "20 / Tool result", group: "Rich", content: [{ type: "tool_use", id: "fixture-tool", name: "read", input: { path: "src/example.ts" } }, { type: "tool_result", tool_use_id: "fixture-tool", content: [{ type: "text", text: "```ts\n" + "const example = true;\n".repeat(30) + "```" }], is_error: false }] },
    { id: "local", title: "21 / Sending", group: "States", text: "Sending a short message", local: true },
    { id: "error", title: "22 / Send error", group: "States", text: "Message draft", error: "The message could not be sent. Check the connection and try again." },
    { id: "error-only", title: "23 / Error without body", group: "States", text: "", error: "Request failed." },
    { id: "content-only", title: "24 / Content without summary", group: "States", content: [{ type: "text", text: "你好" }], summary: null },
    { id: "summary", title: "25 / Summary differs from body", group: "States", content: [{ type: "text", text: "This is the rendered message body, not the summary." }], summary: "Short summary" },
    { id: "text-only", title: "26 / Text-only record", group: "States", text: "A text-only message", content: [] },
    { id: "empty-tail", title: "27 / Empty trailing block", group: "States", content: [{ type: "text", text: "Last visible text." }, { type: "text", text: "   " }] },
    { id: "invalid-clock", title: "28 / Invalid timestamp", group: "States", text: "Message without a valid clock", invalidClock: true },
    { id: "empty", title: "29 / Empty record", group: "States", text: "", content: [] },
  ];
}

export function fixtureMessage(fixture: BubbleFixture, role: "user" | "assistant"): MessageRecord {
  const text = fixture.summary !== undefined ? fixture.summary : fixture.text ?? null;
  return {
    id: `bubble-${fixture.id}-${role}`, sessionId: "bubble-layout-fixtures", role,
    content: fixture.content ?? [{ type: "text", text: fixture.text ?? "" }], text,
    sequence: role === "user" ? 1 : 2, provider: role === "assistant" ? "cohub" : null,
    model: role === "assistant" ? "debug-agent" : null,
    stopReason: "stop", errorMessage: fixture.error ?? null,
    usage: role === "assistant" ? { input: 1200, output: 20, cacheRead: 300, cacheWrite: 0, totalTokens: 1520 } : null,
    meta: { turnId: "fixture-turn", turnSequence: 1 }, authorUuid: null, authorProfile: null,
    startedAt: null, completedAt: null, durationMs: 0,
    createdAt: fixture.invalidClock ? "invalid-date" : "2026-09-11T00:40:00",
  };
}
